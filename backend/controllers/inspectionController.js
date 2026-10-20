const { prisma } = require('../config/database');
const { resolveBase64InValue } = require('../config/cloudinary');
const { validateInspectionPayload } = require('../utils/inspectionValidation');
const {
    verifyCheckerAtVendor,
    buildLocationStamp,
    LOCATION_THRESHOLD_METERS,
} = require('../utils/locationUtils');

// Create an Inspection Assignment
const createInspection = async (req, res) => {
    try {
        const {
            vendorId,
            checkerId,
            poNumber, // Kept optional for backwards compatibility
            clientName,
            scheduledDate,
            scheduledTime,
            priority,
            estimatedDuration,
            itemsToInspect,
            parentInspectionId, // For re-inspections
            cycleNumber,        // For re-inspections
        } = req.body;

        // Validate required fields
        if (!vendorId || !checkerId || !clientName || !scheduledDate || !scheduledTime || !priority || !itemsToInspect) {
            return res.status(400).json({ error: 'Missing required configuration for QC Assignment' });
        }

        // Reject past dates
        const today = new Date(); today.setHours(0, 0, 0, 0);
        if (new Date(scheduledDate) < today) {
            return res.status(400).json({ error: 'Scheduled date cannot be in the past' });
        }

        // Optional validation: Ensure QC Checker exists
        const checker = await prisma.qCChecker.findUnique({ where: { id: checkerId } });
        if (!checker) {
            return res.status(404).json({ error: 'Assigned QC Checker not found' });
        }

        // Optional validation: Ensure Vendor exists
        const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
        if (!vendor) {
            return res.status(404).json({ error: 'Vendor not found' });
        }

        // Maker-checker: the registration must be reviewed & qualified before a
        // factory inspection is scheduled. A PENDING vendor has not been reviewed.
        if (vendor.status === 'PENDING') {
            return res.status(400).json({
                success: false,
                error: 'Review the vendor registration first (mark it Reviewed & Qualified) before assigning a QC checker.',
            });
        }

        // Invariant: a vendor can have at most one active inspection at a time.
        // Prevents admin double-click / rescheduling from creating duplicate
        // SCHEDULED rows, which let checkers unintentionally submit the same
        // report twice and produce duplicate COMPLETED history entries.
        // Note: SUBMITTED inspections are excluded — they're pending admin review, not active for the checker.
        const active = await prisma.inspection.findFirst({
            where: { vendorId, status: { in: ['SCHEDULED', 'IN_PROGRESS'] } },
            select: { id: true, status: true, scheduledDate: true },
        });
        if (active) {
            return res.status(409).json({
                success: false,
                error: 'An active inspection already exists for this vendor',
                message: `Complete or cancel the existing ${active.status.toLowerCase()} inspection (scheduled ${active.scheduledDate}) before scheduling a new one.`,
                activeInspectionId: active.id,
            });
        }

        const newInspection = await prisma.inspection.create({
            data: {
                vendorId,
                checkerId,
                poNumber: poNumber || "", // Set empty string if no PO number
                clientName,
                scheduledDate,
                scheduledTime,
                priority,
                estimatedDuration: estimatedDuration || '1 Hour',
                itemsToInspect: await resolveBase64InValue(itemsToInspect, { folder: 'inspections' }),
                status: 'SCHEDULED',
                parentInspectionId: parentInspectionId || null,
                cycleNumber: cycleNumber || 1,
            }
        });

        // Also update the vendor's assignedQcId (legacy fallback / dashboard viewing ease)
        await prisma.vendor.update({
            where: { id: vendorId },
            data: { assignedQcId: checkerId, assignedQcAt: new Date(), status: 'UNDER_REVIEW' }
        });

        // Notify the QC checker — in-app feed + FCM push
        const vendorName = vendor?.companyName || 'Vendor';
        const { createNotification: createInspNotif } = require('./notificationController');
        createInspNotif({
            userId: checkerId, role: 'QC_CHECKER', type: 'INSPECTION_SCHEDULED',
            title: 'Inspection Scheduled',
            message: `Inspection for "${vendorName}" scheduled on ${scheduledDate}.`,
            data: { screen: 'vendors', vendorId }
        }).catch(() => {});

        // Notify the vendor by email immediately that a factory inspection is assigned.
        // Fire-and-forget — a mail failure must never fail the assignment itself.
        try {
            const { sendFactoryInspectionAssignedEmail } = require('../utils/email/vendorEmailSender');
            sendFactoryInspectionAssignedEmail({
                to: vendor?.email || vendor?.businessEmail || vendor?.ownerEmail,
                companyName: vendor?.companyName,
                ownerName: vendor?.ownerName,
                checkerName: checker?.name,
                scheduledDate,
                scheduledTime,
                priority,
                estimatedDuration: estimatedDuration || '1 Hour',
            }).catch((e) => console.error('Factory-inspection vendor email failed:', e?.message || e));
        } catch (e) {
            console.error('Factory-inspection vendor email dispatch error:', e?.message || e);
        }

        res.status(201).json({ success: true, message: 'Inspection assigned successfully', inspection: newInspection });
    } catch (error) {
        console.error('Error creating inspection:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// QC Checker fetches their assigned Inspections
const getInspectionsByChecker = async (req, res) => {
    try {
        const checkerId = req.user.id; // From authMiddleware

        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 12, 1), 50);
        const search = (req.query.search || '').trim().slice(0, 100);
        const result = req.query.result || '';
        const ALLOWED_SORT_FIELDS = ['scheduledDate', 'completedAt', 'createdAt'];
        const sortBy = ALLOWED_SORT_FIELDS.includes(req.query.sortBy) ? req.query.sortBy : 'completedAt';
        const sortOrder = req.query.sortOrder === 'asc' ? 'asc' : 'desc';
        const ALLOWED_STATUSES = ['COMPLETED', 'SCHEDULED', 'IN_PROGRESS', 'SUBMITTED', 'UNDER_ADMIN_REVIEW', 'REJECTED', 'REINSPECTION', 'CANCELLED'];
        const status = ALLOWED_STATUSES.includes(req.query.status) ? req.query.status : '';

        const where = { checkerId };

        // If status filter is provided use it, otherwise default to COMPLETED for reports
        if (status) {
            where.status = status;
        } else {
            where.status = 'COMPLETED';
        }

        if (result === 'PASSED' || result === 'FAILED') {
            where.result = result;
        }

        if (search) {
            where.OR = [
                { vendor: { companyName: { contains: search, mode: 'insensitive' } } },
                { clientName: { contains: search, mode: 'insensitive' } },
                { notes: { contains: search, mode: 'insensitive' } },
            ];
        }

        const [inspections, total] = await Promise.all([
            prisma.inspection.findMany({
                where,
                select: {
                    id: true,
                    clientName: true,
                    scheduledDate: true,
                    priority: true,
                    status: true,
                    inspectionType: true,
                    completedAt: true,
                    result: true,
                    score: true,
                    notes: true,
                    createdAt: true,
                    updatedAt: true,
                    vendor: {
                        select: {
                            id: true,
                            vendorCode: true,
                            companyName: true,
                        }
                    }
                },
                orderBy: { [sortBy]: sortOrder },
                skip: (page - 1) * limit,
                take: limit,
            }),
            prisma.inspection.count({ where }),
        ]);

        res.json({
            success: true,
            inspections,
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
            },
        });
    } catch (error) {
        console.error('Error fetching QC checker inspections:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// Start an Inspection — requires checker GPS within 500m of vendor factory
const startInspection = async (req, res) => {
    try {
        const { id } = req.params; // inspection id
        const checkerId = req.user.id; // ensuring only assigned checker can start
        const { checkerLatitude, checkerLongitude } = req.body;

        const inspection = await prisma.inspection.findUnique({ where: { id } });

        if (!inspection) {
            return res.status(404).json({ error: 'Inspection not found' });
        }

        if (inspection.checkerId !== checkerId) {
            return res.status(403).json({ error: 'Unauthorized to start this inspection' });
        }

        // Inspection type is chosen when the checker first starts. On resume it stays
        // fixed UNLESS the checker explicitly discards the saved draft to start over
        // (discardDraft) — then the newly chosen type wins and the form resets.
        const requestedType = String(req.body.inspectionType).toUpperCase() === 'VIRTUAL' ? 'VIRTUAL' : 'PHYSICAL';
        const discardDraft = req.body.discardDraft === true || req.body.discardDraft === 'true';
        const inspectionType = inspection.status === 'SCHEDULED'
            ? requestedType
            : (discardDraft ? requestedType : inspection.inspectionType);

        // Both SCHEDULED (first start) and IN_PROGRESS (retry) re-verify
        // against the CURRENT vendor coordinates — so if admin updates the
        // vendor's mapLink mid-inspection, the next start call checks the
        // checker against the NEW location and refreshes the snapshot. Any
        // other status (COMPLETED, SUBMITTED…) is terminal.
        if (inspection.status !== 'SCHEDULED' && inspection.status !== 'IN_PROGRESS') {
            return res.status(400).json({ error: `Cannot start an inspection that is currently ${inspection.status}` });
        }

        // ── Deadline guard ─────────────────────────────────────────────
        // The inspection form can only be OPENED inside its booked window
        // [scheduledStart, scheduledStart + estimatedDuration]. Once the whole
        // window has elapsed, block opening it — whether the assignment was never
        // started (SCHEDULED) or opened once but not submitted (IN_PROGRESS; the
        // form auto-flips SCHEDULED → IN_PROGRESS on first load, so this state
        // does NOT mean active work). Mark it EXPIRED (frees the vendor for
        // reassignment) and alert admin + the checker.
        // A genuinely-started inspection (IN_PROGRESS with a real startedAt) can be
        // RESUMED past its booked window — overtime is highlighted on the report/lists,
        // never blocked. Only a never-genuinely-started assignment expires here.
        const { getInspectionDeadline, isInspectionWindowElapsed } = require('../utils/inspectionSchedule');
        const genuinelyStarted = inspection.status === 'IN_PROGRESS' && !!inspection.startedAt;
        if (!genuinelyStarted && (inspection.status === 'SCHEDULED' || inspection.status === 'IN_PROGRESS') && isInspectionWindowElapsed(inspection)) {
            const deadline = getInspectionDeadline(inspection);
            await prisma.inspection.update({
                where: { id },
                data: { status: 'EXPIRED', expiredAt: new Date() },
            }).catch((e) => console.error('Failed to mark inspection expired on start:', e));

            // Notify the checker (in-app) and admins (in-app) that it lapsed.
            try {
                const vendorRecord = await prisma.vendor.findUnique({ where: { id: inspection.vendorId }, select: { companyName: true } });
                const vendorName = vendorRecord?.companyName || 'Vendor';
                const { createNotification, createNotificationForRole } = require('./notificationController');
                createNotification({
                    userId: inspection.checkerId, role: 'QC_CHECKER', type: 'INSPECTION_EXPIRED',
                    title: 'Inspection Window Expired',
                    message: `The inspection for "${vendorName}" scheduled on ${inspection.scheduledDate} at ${inspection.scheduledTime} can no longer be started — its time window has passed.`,
                    data: { screen: 'vendors', vendorId: inspection.vendorId },
                }).catch(() => {});
                createNotificationForRole({
                    role: 'ADMIN', type: 'INSPECTION_EXPIRED',
                    title: 'Inspection Missed',
                    message: `"${vendorName}" inspection (scheduled ${inspection.scheduledDate} ${inspection.scheduledTime}) expired — the checker did not start it in time. Reassign a new QC checker.`,
                    data: { screen: 'assign-qc-checker', vendorId: inspection.vendorId },
                }).catch(() => {});
            } catch (e) {
                console.error('Failed to send inspection-expired notifications:', e);
            }

            return res.status(409).json({
                success: false,
                code: 'INSPECTION_EXPIRED',
                error: 'Inspection window has passed',
                message: `This inspection can no longer be started. Its scheduled window (${inspection.scheduledDate} ${inspection.scheduledTime}${deadline ? `, valid until ${deadline.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}` : ''}) has already ended. Please ask the admin to schedule a new assignment.`,
            });
        }

        // ── Location verification ──────────────────────────────────────
        // Delegates to the shared guard so start, submit and the product-inspection
        // endpoints all apply one rule. This used to be an inline copy that drifted:
        // it allowed a start when the vendor had no coordinates while the shared guard
        // rejected the same case, so a vendor could pass the start and fail the submit.
        const vendor = await prisma.vendor.findUnique({
            where: { id: inspection.vendorId },
            select: { id: true, factoryLatitude: true, factoryLongitude: true, warehouseLatitude: true, warehouseLongitude: true, companyName: true, mapLink: true },
        });

        const geo = await verifyCheckerAtVendor({
            vendor,
            checkerLatitude: checkerLatitude != null ? parseFloat(checkerLatitude) : null,
            checkerLongitude: checkerLongitude != null ? parseFloat(checkerLongitude) : null,
            prisma,
            label: `startInspection ${id}`,
            inspectionType,
        });
        if (!geo.ok) {
            return res.status(geo.status).json(geo.body);
        }

        const wasScheduled = inspection.status === 'SCHEDULED';
        const hasCheckerCoords = checkerLatitude != null && checkerLongitude != null;

        // ── Draft / pause-resume timing ────────────────────────────────
        // First start stamps startedAt. A resume either discards the draft (type
        // changed) and restarts the clock fresh, or continues the same draft —
        // folding the elapsed pause gap into totalPausedMs so the report's
        // active/paused/total duration stays accurate.
        let resumeFields = {};
        if (wasScheduled) {
            resumeFields = { status: 'IN_PROGRESS', startedAt: new Date() };
        } else if (discardDraft) {
            resumeFields = { draftData: null, pausedAt: null, totalPausedMs: 0, startedAt: new Date() };
        } else if (inspection.pausedAt) {
            const pausedMs = Math.max(0, Date.now() - new Date(inspection.pausedAt).getTime());
            resumeFields = { pausedAt: null, totalPausedMs: (inspection.totalPausedMs || 0) + pausedMs };
        }

        // ── All checks passed — start (or refresh) the inspection ───────
        const updatedInspection = await prisma.inspection.update({
            where: { id },
            data: {
                inspectionType,
                // Record the checker's GPS whenever it was sent, even on an unverified
                // run — the report stays auditable and an admin can check it later.
                // A virtual inspection sends no GPS, so nothing is written here.
                ...(hasCheckerCoords ? {
                    checkerLatitude: parseFloat(checkerLatitude),
                    checkerLongitude: parseFloat(checkerLongitude),
                } : {}),
                ...(geo.vendorLat != null ? { vendorLatitude: geo.vendorLat, vendorLongitude: geo.vendorLng } : {}),
                locationVerified: geo.verified === true,
                ...(geo.distanceM != null ? { locationDistanceM: Math.round(geo.distanceM) } : {}),
                ...(geo.matchedAddress ? { locationMatchedAddress: geo.matchedAddress } : {}),
                ...resumeFields,
            },
            include: {
                vendor: true
            }
        });

        res.json({
            success: true,
            message: geo.verified === true
                ? 'Inspection started'
                : geo.reason === 'VIRTUAL'
                    ? 'Virtual inspection started (no location captured)'
                    : geo.skipped
                        ? 'Inspection started (geofence disabled)'
                        : 'Inspection started — location could not be verified (vendor has no factory coordinates on file)',
            inspection: updatedInspection,
            locationVerification: {
                verified: geo.verified === true,
                ...(geo.distanceM != null ? { distanceMeters: Math.round(geo.distanceM) } : {}),
                thresholdMeters: LOCATION_THRESHOLD_METERS,
                ...(geo.reason ? { reason: geo.reason } : {}),
            },
        });
    } catch (error) {
        console.error('Error starting inspection:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};


// Save a draft (pause) of an in-progress inspection. Persists the checker's
// half-filled form so they can exit and resume later. Marks the pause start; the
// elapsed pause time is folded into totalPausedMs on the next start (resume).
const saveInspectionDraft = async (req, res) => {
    try {
        const { id } = req.params;
        const checkerId = req.user.id;
        const { draftData } = req.body;

        const inspection = await prisma.inspection.findUnique({ where: { id } });
        if (!inspection) {
            return res.status(404).json({ error: 'Inspection not found' });
        }
        if (inspection.checkerId !== checkerId) {
            return res.status(403).json({ error: 'Unauthorized to draft this inspection' });
        }
        if (inspection.status !== 'IN_PROGRESS') {
            return res.status(400).json({ error: `Cannot draft an inspection that is currently ${inspection.status}` });
        }

        const updated = await prisma.inspection.update({
            where: { id },
            data: {
                draftData: draftData ?? {},
                // Mark the pause start once per pause cycle. Resume clears pausedAt, so
                // keeping the earliest here means no paused time is ever double-counted.
                ...(inspection.pausedAt ? {} : { pausedAt: new Date() }),
            },
        });

        res.json({ success: true, message: 'Draft saved', inspection: updated });
    } catch (error) {
        console.error('Error saving inspection draft:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};


// Get latest inspection for a vendor (Admin)
const getInspectionByVendorId = async (req, res) => {
    try {
        const { vendorId } = req.params;
        const inspection = await prisma.inspection.findFirst({
            where: { vendorId },
            orderBy: { createdAt: 'desc' }
        });

        // Return 200 with null inspection if none found (not a 404 - it's a valid "not yet assigned" state)
        res.json({ success: true, inspection: inspection || null });
    } catch (error) {
        console.error('Error fetching vendor inspection:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// Update an existing inspection assignment
const updateInspection = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            vendorId, // Optional but just in case
            checkerId,
            poNumber,
            clientName,
            scheduledDate,
            scheduledTime,
            priority,
            estimatedDuration,
            itemsToInspect
        } = req.body;

        // Reject past dates
        if (scheduledDate) {
            const today = new Date(); today.setHours(0, 0, 0, 0);
            if (new Date(scheduledDate) < today) {
                return res.status(400).json({ error: 'Scheduled date cannot be in the past' });
            }
        }

        // A missed (EXPIRED) assignment being given a fresh window is a REASSIGNMENT —
        // revive it back to SCHEDULED and clear the expiry stamps, otherwise it stays
        // "Expired · Missed" forever (admin badge never clears, and the checker's
        // begin-inspection guard keeps returning INSPECTION_EXPIRED). Only EXPIRED is
        // revived; live states (SCHEDULED/IN_PROGRESS/…) keep their status on edit.
        const existing = await prisma.inspection.findUnique({ where: { id }, select: { status: true, vendorId: true } });
        const reviving = existing?.status === 'EXPIRED' && !!scheduledDate;

        const updatedInspection = await prisma.inspection.update({
            where: { id },
            data: {
                checkerId,
                poNumber: poNumber || "",
                clientName,
                scheduledDate,
                scheduledTime,
                priority,
                estimatedDuration,
                itemsToInspect: await resolveBase64InValue(itemsToInspect, { folder: 'inspections' }),
                ...(reviving ? { status: 'SCHEDULED', expiredAt: null, reminderSentAt: null } : {}),
            }
        });

        if (checkerId) {
            await prisma.vendor.update({
                where: { id: updatedInspection.vendorId },
                data: { assignedQcId: checkerId, status: 'UNDER_REVIEW' }
            });
        }

        // Tell the (re)assigned checker they have a fresh window to inspect.
        if (reviving && checkerId) {
            try {
                const vendorRecord = await prisma.vendor.findUnique({ where: { id: updatedInspection.vendorId }, select: { companyName: true } });
                const { createNotification } = require('./notificationController');
                createNotification({
                    userId: checkerId, role: 'QC_CHECKER', type: 'INSPECTION_SCHEDULED',
                    title: 'Inspection Rescheduled',
                    message: `The inspection for "${vendorRecord?.companyName || 'a vendor'}" has been rescheduled to ${scheduledDate}${scheduledTime ? ` at ${scheduledTime}` : ''}. Please complete it within the new window.`,
                    data: { screen: 'vendors', vendorId: updatedInspection.vendorId },
                }).catch(() => {});
            } catch (e) { console.error('Reassign notify failed:', e); }
        }

        // Email the vendor with the updated factory inspection schedule (reassignment).
        // Fire-and-forget — a mail failure must never fail the update itself.
        try {
            const [vendorRec, checkerRec] = await Promise.all([
                prisma.vendor.findUnique({
                    where: { id: updatedInspection.vendorId },
                    select: { companyName: true, ownerName: true, email: true, businessEmail: true, ownerEmail: true },
                }),
                updatedInspection.checkerId
                    ? prisma.qCChecker.findUnique({ where: { id: updatedInspection.checkerId }, select: { name: true } })
                    : null,
            ]);
            const { sendFactoryInspectionAssignedEmail } = require('../utils/email/vendorEmailSender');
            sendFactoryInspectionAssignedEmail({
                to: vendorRec?.email || vendorRec?.businessEmail || vendorRec?.ownerEmail,
                companyName: vendorRec?.companyName,
                ownerName: vendorRec?.ownerName,
                checkerName: checkerRec?.name,
                scheduledDate: updatedInspection.scheduledDate,
                scheduledTime: updatedInspection.scheduledTime,
                priority: updatedInspection.priority,
                estimatedDuration: updatedInspection.estimatedDuration,
            }).catch((e) => console.error('Factory-inspection reassign vendor email failed:', e?.message || e));
        } catch (e) {
            console.error('Factory-inspection reassign vendor email dispatch error:', e?.message || e);
        }

        res.json({ success: true, message: 'Inspection updated successfully', inspection: updatedInspection });
    } catch (error) {
        console.error('Error updating inspection:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// Complete an Inspection and save results
// Now sets status to SUBMITTED (pending admin review) instead of COMPLETED
const completeInspection = async (req, res) => {
    try {
        const { id } = req.params;
        const checkerId = req.user?.checkerId || req.user?.id || req.userId;
        const checkerName = req.user?.name || req.user?.email || 'QC Checker';
        const formData = req.body;
        const { checkerLatitude, checkerLongitude } = req.body;

        const inspection = await prisma.inspection.findUnique({ where: { id } });

        if (!inspection) {
            return res.status(404).json({ error: 'Inspection not found' });
        }

        if (inspection.checkerId !== checkerId) {
            return res.status(403).json({ error: 'Unauthorized to complete this inspection' });
        }

        if (inspection.status === 'COMPLETED' || inspection.status === 'SUBMITTED') {
            return res.status(400).json({ error: `Inspection is already ${inspection.status.toLowerCase()}` });
        }

        if (inspection.status === 'CANCELLED') {
            return res.status(400).json({ error: 'Cannot complete a cancelled inspection' });
        }

        // ── Submit-time geofence — checker must STILL be at the vendor's factory
        //   when submitting (not just when starting). Mirrors the product flow so
        //   the location guarantee is identical for factory + product inspections.
        const vendor = await prisma.vendor.findUnique({
            where: { id: inspection.vendorId },
            select: {
                id: true,
                factoryLatitude: true,
                factoryLongitude: true,
                warehouseLatitude: true,
                warehouseLongitude: true,
                mapLink: true,
                companyName: true,
            },
        });
        // Type was fixed at start — the stored value is authoritative, so a virtual
        // inspection skips the geofence at submit exactly as it did at start.
        const geo = await verifyCheckerAtVendor({
            vendor,
            checkerLatitude,
            checkerLongitude,
            prisma,
            label: `completeInspection ${id}`,
            inspectionType: inspection.inspectionType,
        });
        // The "vendor has no coordinates" and "virtual" cases are handled inside the
        // guard now (both return ok with verified:false), so every remaining failure is
        // a real block: missing checker GPS, or the checker being outside the radius.
        if (!geo.ok) {
            return res.status(geo.status).json(geo.body);
        }

        // Defence-in-depth: validate the payload server-side. The UI blocks this
        // already, but direct API calls or stale frontends could bypass it.
        const validationErrors = validateInspectionPayload(formData);
        if (Object.keys(validationErrors).length > 0) {
            return res.status(400).json({
                error: 'Validation failed',
                message: 'Some required fields are missing or invalid.',
                fieldErrors: validationErrors,
            });
        }

        const mapStatusToResult = (formStatus) => {
            switch (formStatus) {
                case 'Approved': return 'PASSED';
                case 'Rejected': return 'FAILED';
                // "On Hold" and "Re-inspection Required" are non-approvals — the
                // result enum only has PASSED/FAILED, so they map to FAILED while
                // the exact choice stays in the stored form data for the admin.
                case 'On Hold': return 'FAILED';
                case 'Re-inspection Required': return 'FAILED';
                default: return 'PASSED';
            }
        };

        const resultStatus = formData.inspectionStatus ? mapStatusToResult(formData.inspectionStatus) : 'PASSED';

        // Convert any inline base64 data URLs (factory photos / docs) to Cloudinary
        // URLs so the DB only ever stores hosted references — same pattern as
        // createInspection. Without this, completed reports balloon to MBs of base64
        // in Mongo and the admin viewer has to re-decode on every render.
        const persistedFormData = await resolveBase64InValue(formData, { folder: 'inspections' });

        const fromStatus = inspection.status;

        // Build rejection details from form data when inspection is failed
        const rejectionFields = resultStatus === 'FAILED' ? {
            rejectionReason: formData.inspectorRemarks || 'Inspection failed',
            rejectionRemarks: formData.remarks || null,
            rejectionNotes: formData.notes || null,
            locationDetails: formData.factoryAddress || formData.locationDetails || null,
        } : {};

        // Location snapshot, refreshed to the SUBMIT-time GPS so the audit trail
        // reflects where the checker stood when finalising — not where they started.
        //
        // Every part is conditional because the three outcomes differ:
        //   • verified   — checker GPS + vendor coords + distance, locationVerified true
        //   • unverified — checker GPS only (vendor has no coords on file)
        //   • skipped    — geofence switched off; record GPS if the client sent any
        // Writing `locationVerified: true` or `Math.round(null)` in the latter two would
        // fabricate a verification that never ran.
        const hasCoords = checkerLatitude != null && checkerLongitude != null;
        const locationFields = {
            ...(hasCoords ? {
                checkerLatitude: parseFloat(checkerLatitude),
                checkerLongitude: parseFloat(checkerLongitude),
            } : {}),
            ...(geo.vendorLat != null ? { vendorLatitude: geo.vendorLat, vendorLongitude: geo.vendorLng } : {}),
            locationVerified: geo.verified === true,
            ...(geo.distanceM != null ? { locationDistanceM: Math.round(geo.distanceM) } : {}),
            ...(geo.matchedAddress ? { locationMatchedAddress: geo.matchedAddress } : {}),
        };

        const updatedInspection = await prisma.inspection.update({
            where: { id },
            data: {
                status: 'SUBMITTED',
                startedAt: inspection.startedAt || new Date(),
                submittedAt: new Date(),
                completedAt: new Date(),
                // If the inspection was mid-pause when completed, fold the open pause
                // gap into totalPausedMs, then clear the draft/pause state.
                ...(inspection.pausedAt
                    ? { totalPausedMs: (inspection.totalPausedMs || 0) + Math.max(0, Date.now() - new Date(inspection.pausedAt).getTime()) }
                    : {}),
                draftData: null,
                pausedAt: null,
                ...locationFields,
                result: resultStatus,
                notes: formData.inspectorRemarks || '',
                itemsToInspect: persistedFormData,
                ...rejectionFields,
            },
            include: {
                vendor: true
            }
        });

        // Cascade-cancel any sibling SCHEDULED/IN_PROGRESS rows for this vendor.
        // They're now stale — keeping them would let getActiveInspectionForVendor
        // resurface them to the checker, who could submit again and create
        // duplicate COMPLETED history. Self-heals pre-existing bad data.
        await prisma.inspection.updateMany({
            where: {
                vendorId: inspection.vendorId,
                id: { not: id },
                status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
            },
            data: {
                status: 'CANCELLED',
                notes: `Auto-cancelled: superseded by submitted inspection ${id}`,
            },
        });

        // Vendor stays UNDER_REVIEW regardless of pass/fail — admin will finalize
        await prisma.vendor.update({
            where: { id: inspection.vendorId },
            data: { status: 'UNDER_REVIEW' },
        });

        // Write audit log
        await prisma.inspectionAuditLog.create({
            data: {
                entityType: 'FACTORY_INSPECTION',
                entityId: id,
                action: 'SUBMITTED',
                fromStatus,
                toStatus: 'SUBMITTED',
                performedById: checkerId,
                performedByType: 'QC_CHECKER',
                performedByName: checkerName,
                rejectionReason: resultStatus === 'FAILED' ? (formData.inspectorRemarks || 'Inspection failed') : null,
                remarks: formData.remarks || null,
                notes: formData.notes || null,
                // Verified-location stamp at submit time — mirrors the
                // product audit-log format so reports read consistently.
                locationDetails: buildLocationStamp(geo, checkerLatitude, checkerLongitude),
                inspectionData: persistedFormData,
                cycleNumber: inspection.cycleNumber || 1,
            },
        });

        // Notify admins that inspection has been submitted for review
        const { notifications } = require('../utils/notificationService');
        notifications.inspectionSubmitted(
            updatedInspection.vendor?.companyName || 'Vendor',
            resultStatus
        ).catch(console.error);

        res.json({ success: true, message: 'Inspection submitted for admin review', inspection: updatedInspection });
    } catch (error) {
        console.error('Error completing inspection:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// Admin: Get single inspection by ID
const getInspectionById = async (req, res) => {
    try {
        const { id } = req.params;
        const inspection = await prisma.inspection.findUnique({
            where: { id },
            include: {
                vendor: {
                    select: {
                        id: true,
                        vendorCode: true,
                        companyName: true,
                        email: true,
                        ownerName: true,
                        businessPhone: true,
                        businessCity: true,
                        businessState: true,
                        businessAddress: true,
                    }
                },
                checker: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                    }
                }
            }
        });

        if (!inspection) {
            return res.status(404).json({ error: 'Inspection not found' });
        }

        res.json({ success: true, inspection });
    } catch (error) {
        console.error('Error fetching inspection by ID:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// QC Checker: Get one of their own completed inspections by ID
const getMyInspectionById = async (req, res) => {
    try {
        const { id } = req.params;
        const checkerId = req.user.id;

        const inspection = await prisma.inspection.findUnique({
            where: { id },
            include: {
                vendor: {
                    select: {
                        id: true,
                        companyName: true,
                        email: true,
                        ownerName: true,
                        businessPhone: true,
                        businessCity: true,
                        businessState: true,
                    }
                },
                checker: {
                    select: { id: true, name: true, email: true }
                }
            }
        });

        if (!inspection) {
            return res.status(404).json({ error: 'Inspection not found' });
        }

        // Only allow the assigned checker to view
        if (inspection.checkerId !== checkerId) {
            return res.status(403).json({ error: 'Access denied' });
        }

        res.json({ success: true, inspection });
    } catch (error) {
        console.error('Get My Inspection by ID error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

module.exports = {
    createInspection,
    getInspectionsByChecker,
    startInspection,
    saveInspectionDraft,
    getInspectionByVendorId,
    getInspectionById,
    getMyInspectionById,
    updateInspection,
    completeInspection
};
