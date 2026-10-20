const { prisma } = require('../config/database');

// Create a new support ticket
const createTicket = async (req, res) => {
    try {
        const { subject, category, priority, description, attachments } = req.body;
        const userId = req.userId;
        const role = req.user?.role?.toLowerCase() || 'user';

        // Validate required fields
        if (!subject || !category || !description) {
            return res.status(400).json({
                success: false,
                error: 'Subject, category, and description are required',
            });
        }

        // Generate unique Ticket ID e.g., TKT-20240212-XXXX
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const randomStr = Math.random().toString(36).substring(2, 6).toUpperCase();
        const ticketId = `TKT-${dateStr}-${randomStr}`;

        // Get creator details based on role
        let creatorName = 'Unknown';
        let creatorEmail = '';

        if (role === 'vendor') {
            const vendor = await prisma.vendor.findUnique({ where: { id: userId } });
            if (vendor) {
                creatorName = vendor.companyName || vendor.ownerName;
                creatorEmail = vendor.email;
            }
        } else if (role === 'user') {
            const user = await prisma.user.findUnique({ where: { id: userId } });
            if (user) {
                creatorName = user.name;
                creatorEmail = user.email;
            }
        } else if (role === 'admin' || role === 'super_admin') {
            const admin = await prisma.admin.findUnique({ where: { id: userId } });
            if (admin) {
                creatorName = admin.name;
                creatorEmail = admin.email;
            }
        }

        const ticket = await prisma.supportTicket.create({
            data: {
                ticketId,
                subject,
                category,
                priority: priority || 'medium',
                description,
                attachments: attachments || [],
                creatorId: userId,
                creatorType: role, // 'vendor', 'user', 'admin'
                creatorName,
                creatorEmail,
            },
        });

        // Notify admins about new support ticket
        const { createNotificationForRole: notifyAdminsTicket } = require('./notificationController');
        notifyAdminsTicket({
            role: 'ADMIN', type: 'NEW_SUPPORT_TICKET',
            title: 'New Support Ticket',
            message: `"${subject}" from ${creatorName} (${role})`,
            data: { ticketId: ticket.id }
        }).catch(() => {});

        res.status(201).json({
            success: true,
            data: ticket,
            message: 'Support ticket created successfully',
        });
    } catch (error) {
        console.error('Error creating support ticket:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create support ticket',
        });
    }
};

// Get all tickets (For Admin)
const getAllTickets = async (req, res) => {
    try {
        const tickets = await prisma.supportTicket.findMany({
            orderBy: { createdAt: 'desc' },
            include: {
                messages: {
                    orderBy: { createdAt: 'desc' },
                    take: 1, // Get the latest message to show
                }
            }
        });

        res.json({
            success: true,
            data: tickets,
        });
    } catch (error) {
        console.error('Error fetching all tickets:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch tickets',
        });
    }
};

// Get tickets for specific user/vendor
const getMyTickets = async (req, res) => {
    try {
        const { userId } = req;

        const tickets = await prisma.supportTicket.findMany({
            where: { creatorId: userId },
            orderBy: { createdAt: 'desc' },
            include: {
                messages: {
                    orderBy: { createdAt: 'desc' },
                    take: 1,
                }
            }
        });

        res.json({
            success: true,
            data: tickets,
        });
    } catch (error) {
        console.error('Error fetching user tickets:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch tickets',
        });
    }
};

// Get ticket by ID
const getTicketById = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.userId;
        const role = req.user?.role?.toLowerCase() || 'user';

        const ticket = await prisma.supportTicket.findUnique({
            where: { id },
            include: {
                messages: {
                    orderBy: { createdAt: 'asc' },
                },
            },
        });

        if (!ticket) {
            return res.status(404).json({
                success: false,
                error: 'Ticket not found',
            });
        }

        // Access control: Only admins or the ticket creator can view it
        if (role !== 'admin' && role !== 'super_admin' && ticket.creatorId !== userId) {
            return res.status(403).json({
                success: false,
                error: 'Not authorized to view this ticket',
            });
        }

        res.json({
            success: true,
            data: ticket,
        });
    } catch (error) {
        console.error('Error fetching ticket details:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch ticket details',
        });
    }
};

// Update ticket status
const updateTicketStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        // Only admins may change a ticket's status (prevents any logged-in
        // customer/vendor from altering arbitrary tickets by id).
        const role = req.user?.role?.toLowerCase() || 'user';
        if (role !== 'admin' && role !== 'super_admin') {
            return res.status(403).json({ success: false, error: 'Not authorized to change ticket status' });
        }

        const ticket = await prisma.supportTicket.update({
            where: { id },
            data: { status },
            include: {
                messages: {
                    orderBy: { createdAt: 'desc' },
                    take: 1
                }
            }
        });

        res.json({
            success: true,
            data: ticket,
            message: 'Ticket status updated successfully',
        });
    } catch (error) {
        console.error('Error updating ticket status:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update ticket status',
        });
    }
};

// Add a message to a ticket
const addTicketMessage = async (req, res) => {
    try {
        const { id } = req.params;
        const { message, attachments } = req.body;
        const userId = req.userId;
        const role = req.user?.role?.toLowerCase() || 'user';

        if (!message) {
            return res.status(400).json({
                success: false,
                error: 'Message is required',
            });
        }

        const ticket = await prisma.supportTicket.findUnique({
            where: { id },
        });

        if (!ticket) {
            return res.status(404).json({
                success: false,
                error: 'Ticket not found',
            });
        }

        // Access control
        if (role !== 'admin' && role !== 'super_admin' && ticket.creatorId !== userId) {
            return res.status(403).json({
                success: false,
                error: 'Not authorized to reply to this ticket',
            });
        }

        // Determine sender name
        let senderName = 'Unknown';
        if (role === 'admin' || role === 'super_admin') {
            const admin = await prisma.admin.findUnique({ where: { id: userId } });
            senderName = admin?.name || 'Support Team';
        } else if (role === 'vendor') {
            const vendor = await prisma.vendor.findUnique({ where: { id: userId } });
            senderName = vendor?.companyName || vendor?.ownerName || 'Vendor';
        } else {
            const user = await prisma.user.findUnique({ where: { id: userId } });
            senderName = user?.name || 'Customer';
        }

        const newMessage = await prisma.ticketMessage.create({
            data: {
                ticketId: id,
                message,
                attachments: attachments || [],
                senderId: userId,
                senderType: role,
                senderName,
            },
        });

        // Optionally update the ticket updatedAt timestamp
        await prisma.supportTicket.update({
            where: { id },
            data: { updatedAt: new Date() },
        });

        // Notify the other party about the reply
        const { createNotification: createSupportNotif, createNotificationForRole: notifyAdmins } = require('./notificationController');
        if (role === 'admin' || role === 'super_admin') {
            // Admin replied → notify vendor/user who created the ticket
            createSupportNotif({
                userId: ticket.creatorId,
                role: ticket.creatorType === 'vendor' ? 'VENDOR' : 'USER',
                type: 'SUPPORT_REPLY',
                title: 'New Support Reply',
                message: `New reply on your ticket "${ticket.subject}".`,
                data: { ticketId: ticket.id }
            }).catch(() => {});
        } else {
            // Customer/vendor replied → notify admins so the reply isn't missed.
            notifyAdmins({
                role: 'ADMIN',
                type: 'SUPPORT_REPLY',
                title: 'New Support Reply',
                message: `New customer reply on ticket "${ticket.subject}".`,
                data: { ticketId: ticket.id }
            }).catch(() => {});
        }

        res.status(201).json({
            success: true,
            data: newMessage,
            message: 'Reply sent successfully',
        });
    } catch (error) {
        console.error('Error adding ticket message:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to send reply',
        });
    }
};

// Delete a ticket
const deleteTicket = async (req, res) => {
    try {
        const { id } = req.params;

        await prisma.supportTicket.delete({
            where: { id },
        });

        res.json({
            success: true,
            message: 'Ticket deleted successfully',
        });
    } catch (error) {
        console.error('Error deleting ticket:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete ticket',
        });
    }
};

module.exports = {
    createTicket,
    getAllTickets,
    getMyTickets,
    getTicketById,
    updateTicketStatus,
    addTicketMessage,
    deleteTicket,
};
