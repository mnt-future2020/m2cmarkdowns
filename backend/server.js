// Load environment variables FIRST — before any module that reads process.env
// at import time (e.g. config/passport instantiates GoogleStrategy on require),
// otherwise .env-file values are undefined when those modules initialise (F-14).
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const session = require("express-session");
const passport = require("./config/passport");

const { connectDB } = require("./config/database");
const { initializeAdmin } = require("./utils/auth/initializeAdmin");
const sessionManager = require("./utils/auth/sessionManager");

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const app = express();
const PORT = process.env.PORT || 5000;

// CORS Configuration - must be before helmet
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3003",
  "https://m2-c-p6ikdsx.vercel.app",
  "https://m2cmarkdowns.com",
  "https://m2cmarkdowns.in"
  "https://frontend-phi-lyart-67.vercel.app",
  "https://frontend-lhvq0vna6-salmabegam1002-3228s-projects.vercel.app",
  "https://m2c-testing.vercel.app",
  process.env.FRONTEND_URL,
].filter(Boolean);

// Handle OPTIONS preflight requests explicitly for Vercel serverless
app.options("*", (req, res) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.status(204).end();
});

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (mobile apps, Postman, etc.)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.log("CORS blocked origin:", origin);
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// Middleware
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);
app.use(morgan(':method :url :status :response-time ms'));
app.use(
  express.json({
    limit: "50mb",
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  }),
);
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Configure express-session for Google OAuth
app.use(
  session({
    secret: process.env.JWT_SECRET || "your-secret-key",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  }),
);

// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());

// Import routes
// Root endpoint
app.get("/", (req, res) => {
  res.status(200).json({
    message: "M2C API Server",
    version: "1.0.0",
    status: "running",
    endpoints: {
      health: "/health",
      auth: "/api/auth",
      vendors: "/api/vendors",
      categories: "/api/categories",
      products: "/api/products",
      inventory: "/api/inventory",
      cart: "/api/cart",
      wishlist: "/api/wishlist",
    },
  });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    message: "Server is running",
    timestamp: new Date().toISOString(),
  });
});

// Vercel Cron entry point — node-cron never fires on serverless (no
// long-running process), so vercel.json schedules a daily GET here instead.
// Vercel sends "Authorization: Bearer <CRON_SECRET>"; local/manual calls must
// supply the same secret. Without CRON_SECRET set, the endpoint is disabled.
app.get("/api/jobs/overdue-settlements", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res.status(503).json({ success: false, error: "CRON_SECRET is not configured" });
  }
  if (req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  try {
    const { checkOverdueSettlements } = require("./jobs/overdueSettlements");
    const result = await checkOverdueSettlements();
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error("Overdue settlement cron run failed:", error);
    res.status(500).json({ success: false, error: "Overdue settlement check failed" });
  }
});

// Vercel Cron entry point for inspection reminders + auto-expiry. Same auth
// contract as the settlement job above.
app.get("/api/jobs/inspection-schedule-sweep", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res.status(503).json({ success: false, error: "CRON_SECRET is not configured" });
  }
  if (req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  try {
    const { runInspectionScheduleSweep } = require("./jobs/inspectionReminders");
    const result = await runInspectionScheduleSweep();
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error("Inspection schedule sweep failed:", error);
    res.status(500).json({ success: false, error: "Inspection schedule sweep failed" });
  }
});

// Vercel Cron entry point for offer/coupon "ending soon" customer notifications.
// Same auth contract as the jobs above.
app.get("/api/jobs/promo-ending-soon", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res.status(503).json({ success: false, error: "CRON_SECRET is not configured" });
  }
  if (req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  try {
    const { notifyEndingPromos } = require("./jobs/promoEndingSoon");
    const result = await notifyEndingPromos();
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error("Promo ending-soon run failed:", error);
    res.status(500).json({ success: false, error: "Promo ending-soon check failed" });
  }
});

// Vercel Cron entry point for the vendor order-acceptance overdue sweep.
// Same auth contract as the jobs above.
app.get("/api/jobs/vendor-acceptance-sweep", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res.status(503).json({ success: false, error: "CRON_SECRET is not configured" });
  }
  if (req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  try {
    const { runVendorAcceptanceSweep } = require("./jobs/vendorAcceptanceSweep");
    const result = await runVendorAcceptanceSweep();
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error("Vendor-acceptance sweep failed:", error);
    res.status(500).json({ success: false, error: "Vendor-acceptance sweep failed" });
  }
});

app.get("/api/jobs/workflow-escalation", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res.status(503).json({ success: false, error: "CRON_SECRET is not configured" });
  }
  if (req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  try {
    const { runWorkflowEscalation } = require("./jobs/workflowEscalation");
    const result = await runWorkflowEscalation();
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error("Workflow escalation failed:", error);
    res.status(500).json({ success: false, error: "Workflow escalation failed" });
  }
});

app.get("/api/jobs/points-expiry", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res.status(503).json({ success: false, error: "CRON_SECRET is not configured" });
  }
  if (req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  try {
    const { runPointsExpiry } = require("./jobs/pointsExpiry");
    const result = await runPointsExpiry();
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error("Credit-points expiry sweep failed:", error);
    res.status(500).json({ success: false, error: "Credit-points expiry sweep failed" });
  }
});

// Import routes
const authRoutes = require("./routes/auth/authRoutes");
const vendorRoutes = require("./routes/vendorRoutes");
const vendorSettingsRoutes = require("./routes/vendorSettingsRoutes");
const categoryRoutes = require("./routes/categoryRoutes");
const inventoryRoutes = require("./routes/inventoryRoutes");
const productRoutes = require("./routes/productRoutes");
const cartRoutes = require("./routes/cartRoutes");
const wishlistRoutes = require("./routes/wishlistRoutes");
const orderRoutes = require("./routes/orderRoutes");
const paymentSettingsRoutes = require("./routes/paymentSettingsRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const adminProfileRoutes = require("./routes/adminProfileRoutes");
const companyInfoRoutes = require("./routes/companyInfoRoutes");
const gstSettingsRoutes = require("./routes/gstSettingsRoutes");
const hubRoutes = require("./routes/hubRoutes");
const enquiryRoutes = require("./routes/enquiryRoutes");
const contactEnquiryRoutes = require("./routes/contactEnquiryRoutes");
const couponRoutes = require("./routes/couponRoutes");
const offerRoutes = require("./routes/offerRoutes");
const courierRoutes = require("./routes/courierRoutes");
const deliveryZoneRoutes = require("./routes/deliveryZoneRoutes");
const supportRoutes = require("./routes/supportRoutes");
const reviewRoutes = require("./routes/reviewRoutes");
const qcCheckerRoutes = require("./routes/qcCheckerRoutes");
const invoiceSettingsRoutes = require("./routes/invoiceSettingsRoutes");
const inspectionRoutes = require("./routes/inspectionRoutes");
const reinspectionRoutes = require("./routes/reinspectionRoutes");
const priceNegotiationRoutes = require("./routes/priceNegotiationRoutes");
const userManagementRoutes = require("./routes/userManagementRoutes");
const settlementRoutes = require("./routes/settlementRoutes");
const reportsRoutes = require("./routes/reportsRoutes");
const vendorReportsRoutes = require("./routes/vendorReportsRoutes");
const roleRoutes = require("./routes/roleRoutes");
const adminDashboardRoutes = require("./routes/adminDashboardRoutes");
const vendorDashboardRoutes = require("./routes/vendorDashboardRoutes");
const seoSettingsRoutes = require("./routes/seoSettingsRoutes");
const emailTemplateRoutes = require("./routes/emailTemplateRoutes");
const bannerRoutes = require("./routes/bannerRoutes");
const analyticsRoutes = require("./routes/analyticsRoutes");

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/uploads", require("./routes/uploadRoutes"));
app.use("/api/vendors", vendorRoutes);
app.use("/api/vendor-settings", vendorSettingsRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/products", productRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/wishlist", wishlistRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/returns", require("./routes/returnRoutes"));
app.use("/api/wallet", require("./routes/walletRoutes"));
app.use("/api/credit-points", require("./routes/creditPointsRoutes"));
app.use("/api/organization", require("./routes/organizationRoutes"));
app.use("/api/workflows", require("./routes/workflowRoutes"));
app.use("/api/approvals", require("./routes/approvalRoutes"));
app.use("/api/payment-settings", paymentSettingsRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/admin/profile", adminProfileRoutes);
app.use("/api/company-info", companyInfoRoutes);
app.use("/api/gst-settings", gstSettingsRoutes);
app.use("/api/hubs", hubRoutes);
app.use("/api/enquiries", enquiryRoutes);
app.use("/api/contact-enquiries", contactEnquiryRoutes);
app.use("/api/coupons", couponRoutes);
app.use("/api/offers", offerRoutes);
app.use("/api/couriers", courierRoutes);
app.use("/api/delivery-zones", deliveryZoneRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/qc-checkers", qcCheckerRoutes);
app.use("/api/invoice-settings", invoiceSettingsRoutes);
app.use("/api/inspections", inspectionRoutes);
app.use("/api/reinspections", reinspectionRoutes);
app.use("/api/price-negotiations", priceNegotiationRoutes);
app.use("/api/admin/users", userManagementRoutes);
app.use("/api/settlements", settlementRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/vendor-reports", vendorReportsRoutes);
app.use("/api/roles", roleRoutes);
app.use("/api/admin-dashboard", adminDashboardRoutes);
app.use("/api/vendor-dashboard", vendorDashboardRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/seo-settings", seoSettingsRoutes);
app.use("/api/banners", bannerRoutes);
const notificationRoutes = require("./routes/notificationRoutes");
app.use("/api/notifications", notificationRoutes);

const exchangeRateRoutes = require("./routes/exchangeRateRoutes");
app.use("/api/exchange-rate", exchangeRateRoutes);

app.use("/api/email-templates", emailTemplateRoutes);

// Document proxy — fetches Cloudinary raw files server-side, bypassing browser CORS restrictions.
// Accepts only Cloudinary hostnames to prevent open-proxy abuse.
app.get("/api/document-proxy", async (req, res) => {
  const { url, download, name } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "url is required" });
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  if (!/^res\.cloudinary\.com$/i.test(parsed.hostname)) {
    return res.status(400).json({ error: "Only Cloudinary URLs are supported" });
  }

  // Parse Cloudinary URL segments:
  // /{cloudName}/{resourceType}/{deliveryType}[/v{version}]/{publicId}.{ext}
  const segments = parsed.pathname.replace(/^\//, "").split("/");
  const resourceType = segments[1] || "image";
  let idParts = segments.slice(3);
  if (idParts[0] && /^v\d+$/.test(idParts[0])) idParts = idParts.slice(1);
  let publicId = idParts.join("/");
  const extMatch = publicId.match(/\.([a-z0-9]+)$/i);
  const format = extMatch ? extMatch[1] : "";
  if (extMatch) publicId = publicId.slice(0, publicId.lastIndexOf("."));

  const filename =
    typeof name === "string" && name
      ? name
      : decodeURIComponent(parsed.pathname.split("/").pop() || "document");
  // Content-Disposition filename must be ASCII printable (Node.js throws ERR_INVALID_CHAR otherwise)
  const safeFilename = filename.replace(/[^\x20-\x7E]/g, '_');
  const mimeMap = {
    pdf: "application/pdf", doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  };

  // Block downloads for QC checkers regardless of the download param
  let isDownload = download === "true";
  if (isDownload) {
    const authHeader = req.headers.authorization;
    const cookieToken = req.cookies && req.cookies.token;
    const rawToken = (authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null) || cookieToken;
    if (rawToken) {
      try {
        const jwt = require("jsonwebtoken");
        const decoded = jwt.verify(rawToken, process.env.JWT_SECRET);
        if (decoded && decoded.type === "qc_checker") {
          return res.status(403).json({ error: "Download not permitted for quality checkers" });
        }
      } catch { /* invalid or expired token — proceed normally */ }
    }
  }

  // Helper: send file buffer with correct headers
  const sendBuffer = (buffer, contentType) => {
    res.set("Content-Type", contentType);
    res.set("Content-Disposition", isDownload
      ? `attachment; filename="${safeFilename}"`
      : "inline"
    );
    res.send(buffer);
  };

  // Helper: send an error that the browser treats as a download (no navigation)
  const sendError = (status, message) => {
    if (isDownload) res.set("Content-Disposition", `attachment; filename="error.json"`);
    res.status(status).json({ error: message });
  };

  // Helper: try Cloudinary archive API for a given resource type
  const tryArchive = async (resType) => {
    const { cloudinary } = require("./config/cloudinary");
    const archiveUrl = cloudinary.utils.download_archive_url({
      public_ids: [publicId],
      resource_type: resType,
      target_format: "zip",
    });
    const archiveResp = await fetch(archiveUrl);
    if (!archiveResp.ok) return null;
    const AdmZip = require("adm-zip");
    const zip = new AdmZip(Buffer.from(await archiveResp.arrayBuffer()));
    const entries = zip.getEntries();
    if (!entries.length) return null;
    return entries[0].getData();
  };

  try {
    // First try: direct CDN fetch (works for public/non-ACL resources)
    const upstream = await fetch(url);
    if (upstream.ok) {
      const ct = upstream.headers.get("content-type") || mimeMap[format] || "application/octet-stream";
      return sendBuffer(Buffer.from(await upstream.arrayBuffer()), ct);
    }

    // Fallback: Cloudinary generate_archive API uses API credentials and bypasses
    // CDN-level ACL restrictions. Try the detected resource type first, then others.
    const typesToTry = [resourceType, ...["image", "raw", "video"].filter(t => t !== resourceType)];
    let fileBuffer = null;
    for (const resType of typesToTry) {
      fileBuffer = await tryArchive(resType).catch(() => null);
      if (fileBuffer) break;
    }

    if (!fileBuffer) {
      return sendError(404, "Document not found");
    }

    const ct = mimeMap[format] || "application/octet-stream";
    return sendBuffer(fileBuffer, ct);
  } catch (err) {
    console.error("document-proxy error:", err?.message || err);
    if (!res.headersSent) sendError(500, "Failed to fetch document");
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: "Route not found",
    path: req.originalUrl,
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Error:", err);

  res.status(err.status || 500).json({
    error:
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err.message,
    ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
  });
});

// Initialize database and admin (for serverless, this runs on each cold start)
let isInitialized = false;

const initializeApp = async () => {
  if (isInitialized) return;

  try {
    await connectDB();

    // Initialize admin user
    const adminResult = await initializeAdmin();
    if (adminResult.success) {
      console.log("✅ Admin initialization completed");
    } else {
      console.log("⚠️ Admin initialization skipped:", adminResult.message);
    }

    // Clean expired sessions
    await sessionManager.cleanExpiredSessions();

    isInitialized = true;
  } catch (error) {
    console.error("❌ Initialization error:", error);
  }
};

// Initialize on import
initializeApp();

// Start server only if not in serverless environment
if (process.env.NODE_ENV !== "production" || !process.env.VERCEL) {
  const server = app.listen(PORT, async () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);

    // Start cron jobs
    try {
      const { startOverdueSettlementCheck } = require('./jobs/overdueSettlements');
      startOverdueSettlementCheck();
      const { startInspectionScheduleSweep } = require('./jobs/inspectionReminders');
      startInspectionScheduleSweep();
      const { startPromoEndingSoonCheck } = require('./jobs/promoEndingSoon');
      startPromoEndingSoonCheck();
      const { startVendorAcceptanceSweep } = require('./jobs/vendorAcceptanceSweep');
      startVendorAcceptanceSweep();
      const { startWorkflowEscalation } = require('./jobs/workflowEscalation');
      startWorkflowEscalation();
      const { startPointsExpiry } = require('./jobs/pointsExpiry');
      startPointsExpiry();
    } catch (error) {
      console.error('Failed to start cron jobs:', error.message);
    }

    // Set up periodic session cleanup (every 6 hours) - only for local dev
    setInterval(
      async () => {
        try {
          console.log("🧹 Running periodic session cleanup...");
          await sessionManager.cleanExpiredSessions();
        } catch (error) {
          console.error("❌ Periodic session cleanup error:", error);
        }
      },
      6 * 60 * 60 * 1000,
    );
  });

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    console.log("SIGTERM received, shutting down gracefully");
    server.close(() => {
      console.log("Process terminated");
    });
    await prisma.$disconnect();
  });

  process.on("SIGINT", async () => {
    console.log("SIGINT received, shutting down gracefully");
    server.close(() => {
      console.log("Process terminated");
    });
    await prisma.$disconnect();
  });
}

module.exports = app;
