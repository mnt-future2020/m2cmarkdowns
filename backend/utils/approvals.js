// ============================================================================
// Maker-checker approvals — generic, cross-module.
//
// Every participating entity carries `approvalStatus` (PENDING | APPROVED |
// REJECTED). A record is created PENDING and is NOT live until an authorised
// person approves it (each module's "goes-live" check also requires APPROVED).
// This module is the single place that knows how to list pending items across
// modules and to apply an approve/reject decision — "pull" model, no extra
// request table.
//
// To add a new module: add one entry to MODULE_CONFIG and (a) set approvalStatus
// PENDING + submittedBy on create, (b) gate its live-check on APPROVED.
// ============================================================================

const { prisma } = require('../config/database');

const MODULE_CONFIG = {
  coupon: {
    model: 'coupon',
    permission: 'coupons:approve',
    label: 'Coupon',
    select: { id: true, code: true, discountType: true, discountValue: true, isActive: true, submittedByName: true, approvalStatus: true, rejectionReason: true, createdAt: true },
    toItem: (r) => ({ title: r.code, subtitle: `${r.discountValue}${r.discountType === 'PERCENTAGE' ? '%' : ' ₹'} off` }),
  },
  offer: {
    model: 'offer',
    permission: 'coupons:approve', // offers share the coupons permission set
    label: 'Offer',
    select: { id: true, title: true, type: true, discountPercent: true, discountFlatINR: true, isActive: true, submittedByName: true, approvalStatus: true, rejectionReason: true, createdAt: true },
    toItem: (r) => ({ title: r.title, subtitle: r.type }),
  },
  settlement: {
    model: 'settlement',
    permission: 'settlement:approve',
    label: 'Settlement',
    select: { id: true, vendorName: true, amount: true, orderId: true, status: true, submittedByName: true, approvalStatus: true, rejectionReason: true, createdAt: true },
    toItem: (r) => ({ title: r.vendorName || 'Vendor settlement', subtitle: `₹${(r.amount ?? 0).toLocaleString('en-IN')}` }),
  },
  credit_points: {
    model: 'creditPointsSettings',
    permission: 'points:approve',
    label: 'Credit Points',
    select: { id: true, enabled: true, earnPointsPerUnit: true, earnUnitInr: true, submittedByName: true, approvalStatus: true, rejectionReason: true, createdAt: true },
    toItem: (r) => ({ title: 'Credit Points program', subtitle: r.enabled ? `Enabled · ${r.earnPointsPerUnit}pt / ₹${r.earnUnitInr}` : 'Disabled' }),
  },
  staff: {
    model: 'admin',
    permission: 'staff_management:approve',
    label: 'Staff',
    select: { id: true, name: true, email: true, submittedByName: true, approvalStatus: true, rejectionReason: true, createdAt: true },
    toItem: (r) => ({ title: r.name || r.email, subtitle: r.email }),
  },
  role: {
    model: 'role',
    permission: 'roles_permissions:approve',
    label: 'Role',
    select: { id: true, name: true, description: true, submittedByName: true, approvalStatus: true, rejectionReason: true, createdAt: true },
    toItem: (r) => ({ title: r.name, subtitle: r.description || '' }),
  },
};

const MODULES = Object.keys(MODULE_CONFIG);

// The data patch to stamp on a record when it is submitted for approval.
// Spread this into a create()/update() `data` so new/edited records start PENDING.
function submissionData(actor) {
  return {
    approvalStatus: 'PENDING',
    submittedById: actor?.id || null,
    submittedByName: actor?.name || actor?.email || null,
    approvedById: null,
    approvedByName: null,
    approvedAt: null,
    rejectionReason: null,
  };
}

// Which modules may this admin approve? Super Admin → all.
function approvableModules(user) {
  const isSuper = (user?.roleName || '').toLowerCase().trim() === 'super admin';
  if (isSuper) return [...MODULES];
  const perms = new Set(user?.permissions || []);
  return MODULES.filter((m) => perms.has(MODULE_CONFIG[m].permission));
}

function canApprove(user, module) {
  return approvableModules(user).includes(module);
}

// Ping the authorised approver(s) for a module when something is submitted.
// Fire-and-forget: never blocks or breaks the create/update that triggered it.
function notifyApprovers({ module, entityLabel, submittedByName }) {
  try {
    const cfg = MODULE_CONFIG[module];
    if (!cfg) return;
    const { createNotificationForPermission } = require('../controllers/notificationController');
    createNotificationForPermission(cfg.permission, {
      type: 'APPROVAL_PENDING',
      title: `${cfg.label} awaiting approval`,
      message: `${submittedByName || 'Someone'} submitted ${cfg.label.toLowerCase()}${entityLabel ? ` "${entityLabel}"` : ''} for your approval.`,
      data: { module, screen: 'approvals' },
    });
  } catch (e) {
    console.error('notifyApprovers', e.message);
  }
}

// List all PENDING items across the modules the user can approve.
async function listPending(user, moduleFilter) {
  const mods = approvableModules(user).filter((m) => !moduleFilter || m === moduleFilter);
  const groups = await Promise.all(mods.map(async (m) => {
    const cfg = MODULE_CONFIG[m];
    const rows = await prisma[cfg.model].findMany({
      where: { approvalStatus: 'PENDING' },
      select: cfg.select,
      orderBy: { createdAt: 'desc' },
    }).catch(() => []);
    return rows.map((r) => ({
      module: m,
      moduleLabel: cfg.label,
      id: r.id,
      ...cfg.toItem(r),
      submittedByName: r.submittedByName || null,
      createdAt: r.createdAt,
    }));
  }));
  return groups.flat();
}

// Count of pending items the user can approve (for the sidebar badge).
async function pendingCount(user) {
  const items = await listPending(user);
  return items.length;
}

// Apply a decision. decision: 'APPROVE' | 'REJECT'.
async function decide({ module, id, decision, actor, reason }) {
  const cfg = MODULE_CONFIG[module];
  if (!cfg) throw new Error(`Unknown approval module: ${module}`);

  const record = await prisma[cfg.model].findUnique({ where: { id } });
  if (!record) throw new Error('Record not found');
  if (record.approvalStatus !== 'PENDING') throw new Error('This item has already been decided');

  const now = new Date();
  if (decision === 'APPROVE') {
    await prisma[cfg.model].update({
      where: { id },
      data: {
        approvalStatus: 'APPROVED',
        approvedById: actor?.id || null,
        approvedByName: actor?.name || actor?.email || null,
        approvedAt: now,
        rejectionReason: null,
        // Staff: ensure an approved account is actually enabled to log in.
        ...(module === 'staff' ? { isActive: true } : {}),
      },
    });
    return { module, id, status: 'APPROVED' };
  }

  if (decision === 'REJECT') {
    if (!reason || !String(reason).trim()) throw new Error('A rejection reason is required');
    await prisma[cfg.model].update({
      where: { id },
      data: {
        approvalStatus: 'REJECTED',
        approvedById: actor?.id || null,
        approvedByName: actor?.name || actor?.email || null,
        approvedAt: now,
        rejectionReason: String(reason).trim(),
        // Staff: a rejected account must be disabled so it cannot sign in.
        ...(module === 'staff' ? { isActive: false } : {}),
      },
    });
    return { module, id, status: 'REJECTED' };
  }

  throw new Error(`Unknown decision: ${decision}`);
}

module.exports = {
  MODULE_CONFIG,
  MODULES,
  submissionData,
  approvableModules,
  canApprove,
  notifyApprovers,
  listPending,
  pendingCount,
  decide,
};
