const { prisma } = require('../config/database');
const { resolveVariantImageUrls } = require('../config/cloudinary');

// Create a review
exports.createReview = async (req, res) => {
    try {
        let { productId, orderId, rating, comment, images } = req.body;
        images = await resolveVariantImageUrls(images, { folder: 'reviews' });
        const userId = req.user.id;

        // Validate inputs
        if (!productId || !orderId || !rating) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        // Rating must be a whole number 1–5 (else the product rating average is corrupted).
        const ratingNum = Number(rating);
        if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
            return res.status(400).json({ success: false, message: 'Rating must be a whole number between 1 and 5' });
        }

        // A customer may review a given product only once, ever — regardless of
        // how many times they buy it. Check by (user, product), not the order.
        const existingReview = await prisma.review.findUnique({
            where: {
                userId_productId: {
                    userId,
                    productId
                }
            }
        });

        if (existingReview) {
            return res.status(400).json({ success: false, message: 'You have already reviewed this product' });
        }

        // Verify that the user successfully purchased the product in this order
        const order = await prisma.order.findFirst({
            where: {
                id: orderId,
                customerId: userId,
                items: {
                    some: {
                        productId: productId
                    }
                }
            }
        });

        if (!order) {
            return res.status(403).json({ success: false, message: 'You can only review products from your purchased orders' });
        }

        const review = await prisma.review.create({
            data: {
                userId,
                productId,
                orderId,
                rating: Number(rating),
                comment,
                images: images || [],
                isApproved: false,
                status: 'PENDING',
            }
        });

        // Don't update product rating here — only on admin approval
        // (updateReviewStatus and deleteReview handle recalculation)

        res.status(201).json({ success: true, data: review, message: 'Review submitted and pending approval' });
    } catch (error) {
        console.error('Error creating review:', error);
        res.status(500).json({ success: false, message: 'Error creating review', error: error.message });
    }
};

// Get reviews for a product (only approved + optionally the current user's pending review)
exports.getProductReviews = async (req, res) => {
    try {
        const { productId } = req.params;
        const userId = req.user?.id || null; // may be unauthenticated

        const reviews = await prisma.review.findMany({
            where: {
                productId,
                status: 'APPROVED',
            },
            include: {
                user: {
                    select: {
                        name: true,
                        image: true,
                        // Reviewer's country — shown on the storefront. Prefer the
                        // profile country, else fall back to their default address.
                        country: true,
                        addresses: {
                            where: { isDefault: true },
                            select: { country: true },
                            take: 1,
                        },
                    }
                }
            },
            orderBy: {
                createdAt: 'desc'
            }
        });

        // Flatten the country onto user and drop the raw addresses list.
        const data = reviews.map((r) => {
            const country = r.user?.country || r.user?.addresses?.[0]?.country || null;
            const user = r.user ? { name: r.user.name, image: r.user.image, country } : null;
            return { ...r, user };
        });

        res.status(200).json({ success: true, data });
    } catch (error) {
        console.error('Error fetching reviews:', error);
        res.status(500).json({ success: false, message: 'Error fetching reviews', error: error.message });
    }
};

// Check whether the customer has already reviewed a product (lifetime — the
// orderId param is accepted for backwards compatibility but ignored).
exports.checkReviewStatus = async (req, res) => {
    try {
        const { productId } = req.query;
        const userId = req.user.id;

        if (!productId) {
            return res.status(400).json({ success: false, message: 'Missing product ID' });
        }

        const review = await prisma.review.findUnique({
            where: {
                userId_productId: {
                    userId,
                    productId
                }
            }
        });

        res.status(200).json({ success: true, hasReviewed: !!review, data: review });
    } catch (error) {
        console.error('Error checking review status:', error);
        res.status(500).json({ success: false, message: 'Error checking review status' });
    }
};

// Eligibility for the "Write a Review" modal for a single order: which products
// in the order the customer may still review (never reviewed before, lifetime),
// and whether they've already given purchase-experience feedback for this order.
exports.getOrderReviewEligibility = async (req, res) => {
    try {
        const { orderId } = req.query;
        const userId = req.user.id;

        if (!orderId) {
            return res.status(400).json({ success: false, message: 'Missing order ID' });
        }

        const order = await prisma.order.findFirst({
            where: { id: orderId, customerId: userId },
            include: { items: { select: { productId: true } } }
        });

        if (!order) {
            return res.status(403).json({ success: false, message: 'Order not found' });
        }

        // Distinct products in this order.
        const productIds = [...new Set((order.items || []).map((i) => i.productId).filter(Boolean))];

        // Products this customer has already reviewed (lifetime).
        const reviewed = productIds.length
            ? await prisma.review.findMany({
                where: { userId, productId: { in: productIds } },
                select: { productId: true }
            })
            : [];
        const reviewedSet = new Set(reviewed.map((r) => r.productId));

        // Whether purchase-experience feedback already exists for this order.
        const experience = await prisma.experienceReview.findUnique({
            where: { userId_orderId: { userId, orderId } },
            select: { id: true }
        });

        res.status(200).json({
            success: true,
            data: {
                products: productIds.map((productId) => ({
                    productId,
                    reviewed: reviewedSet.has(productId)
                })),
                experienceReviewed: !!experience
            }
        });
    } catch (error) {
        console.error('Error checking order review eligibility:', error);
        res.status(500).json({ success: false, message: 'Error checking review eligibility' });
    }
};

// Create a purchase-experience feedback review (one per customer per order).
exports.createExperienceReview = async (req, res) => {
    try {
        let { orderId, rating, comment, images } = req.body;
        images = await resolveVariantImageUrls(images, { folder: 'reviews' });
        const userId = req.user.id;

        if (!orderId || !rating) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        // Rating must be a whole number 1–5.
        const ratingNum = Number(rating);
        if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
            return res.status(400).json({ success: false, message: 'Rating must be a whole number between 1 and 5' });
        }

        // The order must belong to this customer.
        const order = await prisma.order.findFirst({
            where: { id: orderId, customerId: userId }
        });
        if (!order) {
            return res.status(403).json({ success: false, message: 'You can only give feedback for your own orders' });
        }

        const existing = await prisma.experienceReview.findUnique({
            where: { userId_orderId: { userId, orderId } }
        });
        if (existing) {
            return res.status(400).json({ success: false, message: 'You have already given feedback for this order' });
        }

        const review = await prisma.experienceReview.create({
            data: {
                userId,
                orderId,
                rating: Number(rating),
                comment,
                images: images || [],
                isApproved: false,
                status: 'PENDING',
            }
        });

        res.status(201).json({ success: true, data: review, message: 'Feedback submitted and pending approval' });
    } catch (error) {
        console.error('Error creating experience review:', error);
        res.status(500).json({ success: false, message: 'Error creating feedback', error: error.message });
    }
};

// Public: approved purchase-experience feedback for the storefront testimonials
// strip, plus the overall M2C store rating (average + count of approved feedback).
// Returns empty/zeroed data on any error so the homepage never breaks.
exports.getPublicExperienceReviews = async (req, res) => {
    try {
        const limit = Math.min(Number(req.query.limit) || 12, 50);

        const reviews = await prisma.experienceReview.findMany({
            where: { status: 'APPROVED' },
            include: {
                user: {
                    select: {
                        name: true,
                        image: true,
                        country: true,
                        addresses: {
                            where: { isDefault: true },
                            select: { country: true },
                            take: 1,
                        },
                    }
                }
            },
            orderBy: { createdAt: 'desc' },
            take: limit,
        });

        const data = reviews.map((r) => {
            const country = r.user?.country || r.user?.addresses?.[0]?.country || null;
            return {
                id: r.id,
                rating: r.rating,
                comment: r.comment,
                createdAt: r.createdAt,
                user: r.user ? { name: r.user.name, image: r.user.image, country } : null,
            };
        });

        const agg = await prisma.experienceReview.aggregate({
            _avg: { rating: true },
            _count: true,
            where: { status: 'APPROVED' },
        });

        res.status(200).json({
            success: true,
            data,
            summary: {
                average: Math.round((agg._avg.rating || 0) * 10) / 10,
                count: agg._count || 0,
            },
        });
    } catch (error) {
        console.error('Error fetching public experience reviews:', error);
        res.status(200).json({ success: true, data: [], summary: { average: 0, count: 0 } });
    }
};

// ==========================================
// ADMIN ENDPOINTS
// ==========================================

// Get all reviews (admin)
exports.getAllReviews = async (req, res) => {
    try {
        const { search, status, page = 1, limit = 20 } = req.query;
        const skip = (Number(page) - 1) * Number(limit);

        // Build where clause
        const where = {};

        if (status && status !== 'all') {
            if (status === 'pending') {
                where.status = 'PENDING';
            } else if (status === 'approved') {
                where.status = 'APPROVED';
            } else if (status === 'rejected') {
                where.status = 'REJECTED';
            }
        }

        const reviews = await prisma.review.findMany({
            where,
            include: {
                user: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        image: true
                    }
                },
                product: {
                    select: {
                        id: true,
                        name: true,
                        images: {
                            select: { url: true, isPrimary: true },
                            orderBy: { isPrimary: 'desc' },
                            take: 1
                        }
                    }
                },
                order: {
                    select: {
                        id: true,
                        orderId: true
                    }
                }
            },
            orderBy: {
                createdAt: 'desc'
            },
            skip,
            take: Number(limit)
        });

        // Apply search filter in JS (MongoDB doesn't support easy OR across relations)
        let filteredReviews = reviews;
        if (search) {
            const searchLower = search.toLowerCase();
            filteredReviews = reviews.filter(review =>
                (review.user?.name || '').toLowerCase().includes(searchLower) ||
                (review.user?.email || '').toLowerCase().includes(searchLower) ||
                (review.product?.name || '').toLowerCase().includes(searchLower) ||
                (review.comment || '').toLowerCase().includes(searchLower)
            );
        }

        // Get counts and average rating in parallel
        const [totalCount, pendingCount, approvedCount, rejectedCount, ratingAggregate] = await Promise.all([
            prisma.review.count(),
            prisma.review.count({ where: { status: 'PENDING' } }),
            prisma.review.count({ where: { status: 'APPROVED' } }),
            prisma.review.count({ where: { status: 'REJECTED' } }),
            prisma.review.aggregate({ _avg: { rating: true }, where: { status: 'APPROVED' } })
        ]);
        const avgRating = ratingAggregate._avg.rating || 0;

        res.status(200).json({
            success: true,
            data: filteredReviews,
            pagination: {
                total: totalCount,
                page: Number(page),
                limit: Number(limit),
                totalPages: Math.ceil(totalCount / Number(limit))
            },
            stats: {
                total: totalCount,
                pending: pendingCount,
                approved: approvedCount,
                rejected: rejectedCount,
                averageRating: Math.round(avgRating * 10) / 10
            }
        });
    } catch (error) {
        console.error('Error fetching all reviews:', error);
        res.status(500).json({ success: false, message: 'Error fetching reviews', error: error.message });
    }
};

// Update review status (approve/reject)
exports.updateReviewStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { isApproved } = req.body;

        if (typeof isApproved !== 'boolean') {
            return res.status(400).json({ success: false, message: 'isApproved must be a boolean value' });
        }

        const review = await prisma.review.findUnique({
            where: { id }
        });

        if (!review) {
            return res.status(404).json({ success: false, message: 'Review not found' });
        }

        const updatedReview = await prisma.review.update({
            where: { id },
            data: {
                isApproved,
                status: isApproved ? 'APPROVED' : 'REJECTED',
            },
            include: {
                user: {
                    select: { name: true, email: true }
                },
                product: {
                    select: { id: true, name: true }
                }
            }
        });

        // Recalculate product average rating (only approved reviews count)
        const approvedReviews = await prisma.review.findMany({
            where: { productId: review.productId, status: 'APPROVED' }
        });

        const avgRating = approvedReviews.length > 0
            ? approvedReviews.reduce((sum, r) => sum + r.rating, 0) / approvedReviews.length
            : 0;

        await prisma.product.update({
            where: { id: review.productId },
            data: {
                rating: avgRating,
                reviews: approvedReviews.length
            }
        });

        res.status(200).json({
            success: true,
            data: updatedReview,
            message: `Review ${isApproved ? 'approved' : 'rejected'} successfully`
        });
    } catch (error) {
        console.error('Error updating review status:', error);
        res.status(500).json({ success: false, message: 'Error updating review status', error: error.message });
    }
};

// Delete a review (admin)
exports.deleteReview = async (req, res) => {
    try {
        const { id } = req.params;

        const review = await prisma.review.findUnique({
            where: { id }
        });

        if (!review) {
            return res.status(404).json({ success: false, message: 'Review not found' });
        }

        await prisma.review.delete({
            where: { id }
        });

        // Recalculate product average rating after deletion
        const remainingReviews = await prisma.review.findMany({
            where: { productId: review.productId, status: 'APPROVED' }
        });

        const avgRating = remainingReviews.length > 0
            ? remainingReviews.reduce((sum, r) => sum + r.rating, 0) / remainingReviews.length
            : 0;

        await prisma.product.update({
            where: { id: review.productId },
            data: {
                rating: avgRating,
                reviews: remainingReviews.length
            }
        });

        res.status(200).json({ success: true, message: 'Review deleted successfully' });
    } catch (error) {
        console.error('Error deleting review:', error);
        res.status(500).json({ success: false, message: 'Error deleting review', error: error.message });
    }
};

// ==========================================
// ADMIN — PURCHASE EXPERIENCE FEEDBACK
// ==========================================

// Get all purchase-experience feedback (admin)
exports.getAllExperienceReviews = async (req, res) => {
    try {
        const { search, status, page = 1, limit = 20 } = req.query;
        const skip = (Number(page) - 1) * Number(limit);

        const where = {};
        if (status && status !== 'all') {
            if (status === 'pending') where.status = 'PENDING';
            else if (status === 'approved') where.status = 'APPROVED';
            else if (status === 'rejected') where.status = 'REJECTED';
        }

        const reviews = await prisma.experienceReview.findMany({
            where,
            include: {
                user: { select: { id: true, name: true, email: true, image: true } },
                order: { select: { id: true, orderId: true } }
            },
            orderBy: { createdAt: 'desc' },
            skip,
            take: Number(limit)
        });

        let filteredReviews = reviews;
        if (search) {
            const s = search.toLowerCase();
            filteredReviews = reviews.filter((r) =>
                (r.user?.name || '').toLowerCase().includes(s) ||
                (r.user?.email || '').toLowerCase().includes(s) ||
                (r.order?.orderId || '').toLowerCase().includes(s) ||
                (r.comment || '').toLowerCase().includes(s)
            );
        }

        const [totalCount, pendingCount, approvedCount, rejectedCount, ratingAggregate] = await Promise.all([
            prisma.experienceReview.count(),
            prisma.experienceReview.count({ where: { status: 'PENDING' } }),
            prisma.experienceReview.count({ where: { status: 'APPROVED' } }),
            prisma.experienceReview.count({ where: { status: 'REJECTED' } }),
            prisma.experienceReview.aggregate({ _avg: { rating: true }, where: { status: 'APPROVED' } })
        ]);
        const avgRating = ratingAggregate._avg.rating || 0;

        res.status(200).json({
            success: true,
            data: filteredReviews,
            pagination: {
                total: totalCount,
                page: Number(page),
                limit: Number(limit),
                totalPages: Math.ceil(totalCount / Number(limit))
            },
            stats: {
                total: totalCount,
                pending: pendingCount,
                approved: approvedCount,
                rejected: rejectedCount,
                averageRating: Math.round(avgRating * 10) / 10
            }
        });
    } catch (error) {
        console.error('Error fetching experience reviews:', error);
        res.status(500).json({ success: false, message: 'Error fetching feedback', error: error.message });
    }
};

// Update experience-review status (approve/reject)
exports.updateExperienceReviewStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { isApproved } = req.body;

        if (typeof isApproved !== 'boolean') {
            return res.status(400).json({ success: false, message: 'isApproved must be a boolean value' });
        }

        const review = await prisma.experienceReview.findUnique({ where: { id } });
        if (!review) {
            return res.status(404).json({ success: false, message: 'Feedback not found' });
        }

        const updatedReview = await prisma.experienceReview.update({
            where: { id },
            data: {
                isApproved,
                status: isApproved ? 'APPROVED' : 'REJECTED',
            },
            include: {
                user: { select: { name: true, email: true } },
                order: { select: { id: true, orderId: true } }
            }
        });

        res.status(200).json({
            success: true,
            data: updatedReview,
            message: `Feedback ${isApproved ? 'approved' : 'rejected'} successfully`
        });
    } catch (error) {
        console.error('Error updating experience review status:', error);
        res.status(500).json({ success: false, message: 'Error updating feedback status', error: error.message });
    }
};

// Delete an experience review (admin)
exports.deleteExperienceReview = async (req, res) => {
    try {
        const { id } = req.params;
        const review = await prisma.experienceReview.findUnique({ where: { id } });
        if (!review) {
            return res.status(404).json({ success: false, message: 'Feedback not found' });
        }
        await prisma.experienceReview.delete({ where: { id } });
        res.status(200).json({ success: true, message: 'Feedback deleted successfully' });
    } catch (error) {
        console.error('Error deleting experience review:', error);
        res.status(500).json({ success: false, message: 'Error deleting feedback', error: error.message });
    }
};
