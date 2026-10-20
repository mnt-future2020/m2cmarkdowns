const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { prisma } = require("../../config/database");
const sessionManager = require("../../utils/auth/sessionManager");
const { sendEmail: sendSMTPEmail, sendEmailWithEnv } = require("../../config/connectSMTP");
const { sendTemplatedEmail } = require("../../utils/emailTemplateRenderer");
const { resolveBase64InValue } = require("../../config/cloudinary");

// Email helper - uses SMTP configuration
const sendEmail = async (emailData) => {
  try {
    console.log("📧 Attempting to send email to:", emailData.to);
    console.log("📧 Email subject:", emailData.subject);

    // Get active email configuration from database
    let emailConfig;
    try {
      emailConfig = await prisma.emailConfiguration.findFirst({
        where: { isActive: true }
      });
    } catch (dbError) {
      console.log("📧 Email configuration table not found, using environment variables");
      emailConfig = null;
    }

    let result;

    if (emailConfig) {
      // Use database SMTP configuration
      console.log("📧 Using database SMTP configuration");
      result = await sendSMTPEmail(emailConfig, {
        to: emailData.to,
        subject: emailData.subject,
        html: emailData.html,
        text: emailData.text || emailData.html?.replace(/<[^>]*>/g, '') // Strip HTML for text version
      });
    } else {
      // Fallback to environment variables
      console.log("📧 Using environment SMTP configuration");
      console.log("📧 SMTP Host:", process.env.SMTP_HOST);
      console.log("📧 SMTP Port:", process.env.SMTP_PORT);
      console.log("📧 SMTP User:", process.env.SMTP_USER);
      console.log("📧 SMTP From:", process.env.SMTP_FROM_EMAIL);

      result = await sendEmailWithEnv({
        to: emailData.to,
        subject: emailData.subject,
        html: emailData.html,
        text: emailData.text || emailData.html?.replace(/<[^>]*>/g, '')
      });
    }

    if (result.success) {
      console.log("✅ Email sent successfully to:", emailData.to);
      console.log("📧 Message ID:", result.messageId);
    } else {
      console.error("❌ Failed to send email:", result.message);
    }

    return result;
  } catch (error) {
    console.error("❌ Email sending error:", error);
    return { success: false, message: error.message };
  }
};

// Generate JWT Token
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: "7d" });
};

// Generate random token
const generateRandomToken = () => {
  return crypto.randomBytes(32).toString("hex");
};

// Register new user
const register = async (req, res) => {
  try {
    console.log("📝 Registration request received:", req.body.email);
    let { email, password, name, phoneNumber } = req.body;

    // Validation
    if (!email || !password || !name || !phoneNumber) {
      return res.status(400).json({
        success: false,
        error: "Email, password, name, and phone number are required",
      });
    }

    // Normalize email so lookups/uniqueness are case-insensitive (prevents
    // duplicate accounts and later login lockouts from casing differences).
    email = String(email).trim().toLowerCase();

    // Minimum password strength.
    if (String(password).length < 6) {
      return res.status(400).json({
        success: false,
        error: "Password must be at least 6 characters.",
      });
    }

    console.log("✅ Validation passed");

    // Determine if this should be an admin or user
    const adminEmails = [process.env.ADMIN_EMAIL];
    const isAdmin = adminEmails.includes(email.toLowerCase());
    console.log("👤 User type:", isAdmin ? "admin" : "user");

    // Check if user/admin already exists in respective collection
    console.log("🔍 Checking for existing user...");
    const existingUser = isAdmin
      ? await prisma.admin.findUnique({ where: { email } })
      : await prisma.user.findUnique({ where: { email } });

    // Also check the other collection to prevent duplicate emails
    const existingInOtherCollection = isAdmin
      ? await prisma.user.findUnique({ where: { email } })
      : await prisma.admin.findUnique({ where: { email } });

    if (existingUser || existingInOtherCollection) {
      console.log("❌ User already exists with email");
      return res.status(400).json({
        success: false,
        error: "Account already exists. Please sign in with your email or phone number and password.",
      });
    }

    // Check if phone number already exists
    console.log("🔍 Checking for existing phone number...");
    const existingPhone = isAdmin
      ? await prisma.admin.findFirst({ where: { phoneNumber } })
      : await prisma.user.findFirst({ where: { phoneNumber } });

    const existingPhoneInOtherCollection = isAdmin
      ? await prisma.user.findFirst({ where: { phoneNumber } })
      : await prisma.admin.findFirst({ where: { phoneNumber } });

    if (existingPhone || existingPhoneInOtherCollection) {
      console.log("❌ Phone number already exists");
      return res.status(400).json({
        success: false,
        error: "Account already exists. Please sign in with your email or phone number and password.",
      });
    }

    console.log("✅ User does not exist, proceeding...");

    // Hash password (reduced salt rounds for faster processing)
    console.log("🔐 Hashing password...");
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    console.log("✅ Password hashed");

    // Generate verification token
    const verificationToken = generateRandomToken();

    // Prepare user data
    const userData = {
      email,
      password: hashedPassword,
      name,
      phoneNumber,
      verificationToken,
    };

    // Create user in appropriate collection
    console.log("💾 Creating user in database...");
    const user = isAdmin
      ? await prisma.admin.create({
        data: userData,
      })
      : await prisma.user.create({
        data: userData,
      });
    console.log("✅ User created:", user.id);

    // Create Customer record for non-admin users (monolith approach)
    let customerId = null;
    if (!isAdmin) {
      try {
        console.log("📝 Creating customer record for user:", user.id);
        const customer = await prisma.customer.create({
          data: {
            userId: user.id,
            email: user.email,
            name: user.name,
            phoneNumber: user.phoneNumber,
            isVerified: false,
            provider: 'local',
          },
        });
        customerId = customer.id;
        console.log("✅ Customer record created:", customer.id);
      } catch (customerError) {
        console.error("❌ Failed to create customer record:");
        console.error("Error details:", customerError);
        console.error("User data:", { userId: user.id, email: user.email, name: user.name });
        // Don't fail registration if customer creation fails
      }
    }

    // Verification link for the DB-driven email template (non-blocking send below).
    const verificationUrl = `${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}`;

    // Send response immediately
    res.status(201).json({
      success: true,
      message:
        "User registered successfully. Please check your email to verify your account.",
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: isAdmin ? "admin" : "user",
      },
    });

    // Send email after response (non-blocking). Security template — always sends.
    setImmediate(async () => {
      const result = await sendTemplatedEmail({
        key: "email_verification",
        to: email,
        data: { name, verificationUrl },
      });
      if (result.sent) {
        console.log(`✅ Verification email sent to: ${email}`);
      } else {
        console.error("Failed to send verification email:", result.reason, result.error?.message || "");
      }
    });

    // Send new user registration notification to admins (only for non-admin users)
    if (!isAdmin) {
      setImmediate(async () => {
        try {
          // await sendNewUserRegistrationAlert(user.name, user.email, customerId);
          console.log(`📱 New user registration notification would be sent to admins`);
        } catch (notifError) {
          console.error('⚠️ Failed to send registration notification:', notifError.message);
        }
      });

      // Send welcome notification to the new user (non-blocking)
      setImmediate(async () => {
        try {
          // await sendWelcomeNotification(user.id, user.name);
          console.log(`🎉 Welcome notification would be sent to user: ${user.name}`);
        } catch (notifError) {
          console.error('⚠️ Failed to send welcome notification:', notifError.message);
        }
      });
    }
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({
      success: false,
      error: "Registration failed",
    });
  }
};

// Login user
const login = async (req, res) => {
  try {
    let { email, password } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: "Email or phone number and password are required",
      });
    }

    // Check if input is email or phone number
    const isEmail = /\S+@\S+\.\S+/.test(email);
    // Normalize email casing so login matches the stored (lowercased) address.
    if (isEmail) email = String(email).trim().toLowerCase();
    const searchField = isEmail ? "email" : "phoneNumber";

    console.log(`🔍 Login attempt with ${searchField}:`, email);

    // Determine if this should be an admin based on email
    const adminEmails = [process.env.ADMIN_EMAIL];
    const isAdminEmail = isEmail && adminEmails.includes(email.toLowerCase());

    let user;
    let userType;

    // Check admin collection first if it's an admin email
    if (isAdminEmail) {
      user = await prisma.admin.findUnique({
        where: { email },
        include: { role: true }
      });
      userType = "admin";
      console.log(`🔍 Checking admin collection for admin email: ${email}`);
    } else {
      // For non-admin emails, check user collection first, then admin
      user = isEmail
        ? await prisma.user.findUnique({ where: { email } })
        : await prisma.user.findFirst({ where: { phoneNumber: email } });
      userType = "user";

      if (!user) {
        user = isEmail
          ? await prisma.admin.findUnique({
            where: { email },
            include: { role: true }
          })
          : await prisma.admin.findFirst({
            where: { phoneNumber: email },
            include: { role: true }
          });
        userType = "admin";
      }
    }

    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Invalid email/phone number or password",
      });
    }

    // Check if user is active
    if (!user.isActive) {
      return res.status(401).json({
        success: false,
        error: "Account is deactivated. Please contact administrator.",
      });
    }

    // Maker-checker: a staff (admin) account cannot sign in until approved.
    // Enforced here too (not only on the dedicated admin login) so the gate
    // can't be bypassed via the shared login endpoint.
    if (userType === "admin" && user.approvalStatus && user.approvalStatus !== "APPROVED") {
      return res.status(403).json({
        success: false,
        error: user.approvalStatus === "REJECTED"
          ? "Your staff account was not approved. Please contact your administrator."
          : "Your staff account is awaiting approval. You'll be able to sign in once it's approved.",
      });
    }

    // Check if email is verified (except for admins)
    if (userType !== "admin" && !user.isVerified) {
      return res.status(401).json({
        success: false,
        error: "Please verify your email before signing in. Check your inbox for the verification link.",
      });
    }

    // For Google OAuth users without password
    if (user.provider === "google" && !user.password) {
      return res.status(409).json({
        success: false,
        code: "GOOGLE_ACCOUNT",
        error: "This account uses Google sign-in. Please continue with Google, or use 'Forgot Password' to set a password for email login.",
      });
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        error: "Invalid email or password",
      });
    }

    // Email verification gate — block login until the user has clicked
    // the verification link sent to their inbox.
    if (!user.isVerified) {
      return res.status(403).json({
        success: false,
        code: 'EMAIL_NOT_VERIFIED',
        error: "Please verify your email first. Check your inbox for the verification link.",
      });
    }

    // Update last login
    const updateData = { lastLogin: new Date() };

    if (userType === "admin") {
      await prisma.admin.update({
        where: { id: user.id },
        data: updateData,
      });
    } else {
      await prisma.user.update({
        where: { id: user.id },
        data: updateData,
      });
    }

    // Generate token
    const token = generateToken(user.id);

    // Track active session
    await sessionManager.addSession(user.id, token);

    // Set httpOnly cookie
    res.cookie('token', token, {
      httpOnly: true,           // JavaScript-ல் access செய்ய முடியாது
      secure: process.env.NODE_ENV === 'production', // HTTPS-ல் மட்டும் (production)
      sameSite: 'lax',          // CSRF protection
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/'
    });

    // Login event removed - not needed for customer sync

    res.json({
      success: true,
      message: "Login successful",
      data: {
        token, // Still send in response for backward compatibility
        user: {
          id: user.id,
          email: user.email,
          title: user.title,
          name: user.name,
          role: userType,
          image: user.image,
          isVerified: user.isVerified,
          phoneNumber: user.phoneNumber,
          address: user.address,
          addressLine2: user.addressLine2,
          city: user.city,
          state: user.state,
          zipCode: user.zipCode,
          country: user.country,
          dateOfBirth: user.dateOfBirth,
          currency: userType === "admin" ? user.currency : undefined,
          companyName: userType === "admin" ? user.companyName : undefined,
          gstNumber: userType === "admin" ? user.gstNumber : undefined,
          onboardingCompleted: userType === "admin" ? user.onboardingCompleted : undefined,
          roleName: userType === "admin" && user.role ? user.role.name : userType,
          permissions: userType === "admin" && user.role ? user.role.permissions : []
        },
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      success: false,
      error: "Login failed",
    });
  }
};

// Google OAuth callback
const googleCallback = async (req, res) => {
  try {
    const { googleId, email, name, image, fcmToken } = req.body;

    if (!googleId || !email || !name) {
      return res.status(400).json({
        success: false,
        error: "Missing required Google OAuth data",
      });
    }

    // Determine if this should be an admin or user
    const adminEmails = [process.env.ADMIN_EMAIL];
    const isAdmin = adminEmails.includes(email.toLowerCase());

    // Check if user exists in appropriate collection
    let user = isAdmin
      ? await prisma.admin.findFirst({
        where: {
          OR: [{ email }, { googleId }],
        },
        include: { role: true }
      })
      : await prisma.user.findFirst({
        where: {
          OR: [{ email }, { googleId }],
        },
      });

    if (user) {
      // Existing user found
      console.log(`👤 Existing user found: ${email} (Provider: ${user.provider}, Verified: ${user.isVerified})`);

      // SECURITY CHECK: If user registered with email/password but NOT verified
      // Don't allow Google login to bypass email verification
      if (user.provider === "local" && !user.isVerified) {
        console.log("⚠️ User registered but email not verified - blocking Google login");
        return res.status(403).json({
          success: false,
          error: "Please verify your email first. Check your inbox for the verification link before signing in with Google.",
        });
      }

      // User is either:
      // 1. Already verified (local provider)
      // 2. Was a Google user before
      // 3. Admin (admins can bypass)
      // Update user with Google credentials (preserve existing name and custom image)
      const updateData = {
        googleId,
        provider: "google",
        isVerified: true, // Safe to set true (already verified or Google user)
        lastLogin: new Date(),
      };

      // Note: FCM token should be saved via dedicated endpoint, not during OAuth

      // Only update name if user was previously a Google user (not local registration)
      // This preserves the name user chose during registration
      if (user.provider === "google") {
        updateData.name = name;
      }

      // Only update image if:
      // 1. User has no image (null) OR
      // 2. User's current image is from Google (contains 'googleusercontent.com' or 'google.com') OR
      // 3. User was previously a Google user
      // This preserves custom uploaded images
      const isGoogleImage = user.image && (
        user.image.includes('googleusercontent.com') ||
        user.image.includes('google.com') ||
        user.image.includes('lh3.googleusercontent.com')
      );

      if (!user.image || isGoogleImage || user.provider === "google") {
        updateData.image = image;
      }

      user = isAdmin
        ? await prisma.admin.update({
          where: { id: user.id },
          data: updateData,
          include: { role: true }, // Keep role attached so login response includes permissions
        })
        : await prisma.user.update({
          where: { id: user.id },
          data: updateData,
        });
      console.log("✅ Existing user updated with Google credentials (name preserved)");
    } else {
      // Create new user in appropriate collection (auto-register)
      console.log("🆕 Auto-registering new Google user:", email);

      const createData = {
        email,
        googleId,
        name,
        image,
        provider: "google",
        isVerified: true, // Google users are auto-verified
        lastLogin: new Date(),
      };

      // For admins auto-registered via Google, attach Super Admin role so they
      // aren't locked out of permission-protected routes on first login.
      if (isAdmin) {
        const superAdminRole = await prisma.role.findUnique({ where: { name: 'Super Admin' } });
        if (superAdminRole) {
          createData.roleId = superAdminRole.id;
        }
        // Google-auth admins are issued a token immediately, so mark them APPROVED
        // to stay consistent with the maker-checker login gate (otherwise a later
        // password login would be blocked as PENDING).
        createData.approvalStatus = 'APPROVED';
      }

      // Note: FCM token should be saved via dedicated endpoint, not during OAuth

      user = isAdmin
        ? await prisma.admin.create({ data: createData, include: { role: true } })
        : await prisma.user.create({ data: createData });
      console.log("✅ Google user auto-registered:", user.id);

      // Create Customer record for non-admin users (monolith approach)
      let customerId = null;
      if (!isAdmin) {
        try {
          console.log("📝 Creating customer record for Google user:", user.id);
          const customer = await prisma.customer.create({
            data: {
              userId: user.id,
              email: user.email,
              name: user.name,
              image: user.image,
              isVerified: true,
              provider: 'google',
            },
          });
          customerId = customer.id;
          console.log("✅ Customer record created for Google user:", customer.id);
        } catch (customerError) {
          console.error("❌ Failed to create customer record for Google user:");
          console.error("Error details:", customerError);
          console.error("User data:", { userId: user.id, email: user.email, name: user.name });
          // Don't fail authentication if customer creation fails
        }

        // Send new user registration notification to admins (non-blocking)
        setImmediate(async () => {
          try {
            // await sendNewUserRegistrationAlert(user.name, user.email, customerId);
            console.log(`📱 New Google user registration notification would be sent to admins`);
          } catch (notifError) {
            console.error('⚠️ Failed to send registration notification:', notifError.message);
          }
        });

        // Send welcome notification to the new Google user (non-blocking)
        setImmediate(async () => {
          try {
            // await sendWelcomeNotification(user.id, user.name);
            console.log(`🎉 Welcome notification would be sent to Google user: ${user.name}`);
          } catch (notifError) {
            console.error('⚠️ Failed to send welcome notification:', notifError.message);
          }
        });
      }
    }

    // Generate token
    const token = generateToken(user.id);

    // Track active session
    await sessionManager.addSession(user.id, token);

    // Set httpOnly cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/'
    });

    res.json({
      success: true,
      message: "Google authentication successful",
      data: {
        token, // Still send for backward compatibility
        user: {
          id: user.id,
          email: user.email,
          title: user.title,
          name: user.name,
          role: isAdmin ? "admin" : "user",
          image: user.image,
          isVerified: user.isVerified,
          phoneNumber: user.phoneNumber,
          address: user.address,
          addressLine2: user.addressLine2,
          city: user.city,
          state: user.state,
          zipCode: user.zipCode,
          country: user.country,
          dateOfBirth: user.dateOfBirth,
          currency: isAdmin ? user.currency : undefined,
          companyName: isAdmin ? user.companyName : undefined,
          gstNumber: isAdmin ? user.gstNumber : undefined,
          onboardingCompleted: isAdmin ? user.onboardingCompleted : undefined,
          roleName: isAdmin && user.role ? user.role.name : (isAdmin ? 'admin' : 'user'),
          permissions: isAdmin && user.role ? user.role.permissions : []
        },
      },
    });
  } catch (error) {
    console.error("Google OAuth error:", error);
    res.status(500).json({
      success: false,
      error: "Google authentication failed",
    });
  }
};

// Verify email
const verifyEmail = async (req, res) => {
  try {
    const { token } = req.body;

    console.log("📧 Email verification request received");

    if (!token) {
      console.log("❌ No token provided");
      return res.status(400).json({
        success: false,
        error: "Verification token is required",
      });
    }

    console.log("🔍 Searching for user with verification token...");

    // Find user with verification token in both collections
    let user = await prisma.user.findFirst({
      where: { verificationToken: token },
    });
    let userType = "user";

    if (!user) {
      user = await prisma.admin.findFirst({
        where: { verificationToken: token },
      });
      userType = "admin";
    }

    if (!user) {
      console.log("❌ No user found with this token");

      // Token not found - could mean already verified or invalid token
      // Return a generic message that's user-friendly
      console.log("ℹ️ Token not found - likely already verified or expired");
      return res.status(200).json({
        success: true,
        message: "Email already verified. You can sign in now.",
        alreadyVerified: true
      });
    }

    console.log(`✅ User found: ${user.email} (${userType})`);

    // Check if already verified
    if (user.isVerified) {
      console.log("ℹ️ User already verified");
      return res.json({
        success: true,
        message: "Email already verified. You can sign in now.",
        alreadyVerified: true
      });
    }

    // Update user as verified in appropriate collection
    let verifiedUser;
    if (userType === "admin") {
      verifiedUser = await prisma.admin.update({
        where: { id: user.id },
        data: {
          isVerified: true,
          verificationToken: null,
        },
      });
    } else {
      verifiedUser = await prisma.user.update({
        where: { id: user.id },
        data: {
          isVerified: true,
          verificationToken: null,
        },
      });
    }

    console.log(`✅ Email verified successfully for: ${verifiedUser.email}`);

    res.json({
      success: true,
      message: "Email verified successfully",
    });
  } catch (error) {
    console.error("Email verification error:", error);
    res.status(500).json({
      success: false,
      error: "Email verification failed. Please try again.",
    });
  }
};

// Forgot password
const forgotPassword = async (req, res) => {
  try {
    let { email, userType: requestedUserType } = req.body;

    console.log("📧 Forgot password request for:", email);
    console.log("👤 Requested user type:", requestedUserType || "auto-detect");

    if (!email) {
      return res.status(400).json({
        success: false,
        error: "Email is required",
      });
    }

    // Match the stored (lowercased) address.
    email = String(email).trim().toLowerCase();

    // Find user in all collections (User, Admin, Vendor)
    // If userType is specified, check that collection first
    console.log("🔍 Searching for user in all collections...");
    let user;
    let userType;

    if (requestedUserType === "vendor") {
      // Vendor-specific request - check vendor collection first
      user = await prisma.vendor.findUnique({
        where: { email },
      });
      userType = "vendor";
      console.log("🔍 Checking vendor collection first (vendor-specific request)");
    } else if (requestedUserType === "admin") {
      // Admin-specific request - check admin collection first
      user = await prisma.admin.findUnique({
        where: { email },
      });
      userType = "admin";
      console.log("🔍 Checking admin collection first (admin-specific request)");
    } else if (requestedUserType === "checker") {
      // QC checker-specific request - check the qc_checkers collection.
      user = await prisma.qCChecker.findUnique({
        where: { email },
      });
      userType = "checker";
      console.log("🔍 Checking QC checker collection (checker-specific request)");
    } else {
      // Regular user or auto-detect - check in order: user → admin → vendor
      user = await prisma.user.findUnique({
        where: { email },
      });
      userType = "user";

      if (!user) {
        user = await prisma.admin.findUnique({
          where: { email },
        });
        userType = "admin";
      }

      if (!user) {
        user = await prisma.vendor.findUnique({
          where: { email },
        });
        userType = "vendor";
      }
    }

    if (!user) {
      console.log("❌ User not found with email:", email);
      // Don't reveal whether an account exists (prevents enumeration) — same
      // generic response as the success path.
      return res.json({
        success: true,
        message: "If an account with that email exists, a password reset link has been sent.",
      });
    }

    console.log(`✅ User found: ${userType} - ${email}`);

    // Generate reset token
    const resetToken = generateRandomToken();
    const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hour

    console.log("🔑 Generated reset token");
    console.log("⏰ Token expires at:", resetTokenExpiry);

    // Update user with reset token in appropriate collection
    console.log(`💾 Saving reset token to ${userType} collection...`);
    if (userType === "admin") {
      await prisma.admin.update({
        where: { id: user.id },
        data: {
          resetToken,
          resetTokenExpiry,
        },
      });
    } else if (userType === "vendor") {
      await prisma.vendor.update({
        where: { id: user.id },
        data: {
          resetToken,
          resetTokenExpiry,
        },
      });
      console.log("✅ Vendor reset token saved");
    } else if (userType === "checker") {
      await prisma.qCChecker.update({
        where: { id: user.id },
        data: {
          resetToken,
          resetTokenExpiry,
        },
      });
      console.log("✅ QC checker reset token saved");
    } else {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          resetToken,
          resetTokenExpiry,
        },
      });
    }

    // Send reset email with appropriate reset URL based on user type. The
    // subject varies only by account type, which the DB template renders from
    // the {{accountType}} variable (subject: "Reset Your {{accountType}} Password").
    let resetUrl;
    let userName;
    let accountType;

    if (userType === "vendor") {
      resetUrl = `${process.env.FRONTEND_URL}/vendor/reset-password?token=${resetToken}`;
      userName = user.ownerName || user.companyName;
      accountType = "Vendor Account";
      console.log("🔗 Vendor reset URL:", resetUrl);
    } else if (userType === "admin") {
      resetUrl = `${process.env.FRONTEND_URL}/admin/reset-password?token=${resetToken}`;
      userName = user.name;
      accountType = "Admin Account";
    } else if (userType === "checker") {
      resetUrl = `${process.env.FRONTEND_URL}/checker/reset-password?token=${resetToken}`;
      userName = user.name;
      accountType = "QC Checker Account";
      console.log("🔗 QC checker reset URL:", resetUrl);
    } else {
      resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;
      userName = user.name;
      accountType = "Account";
    }

    // Send password reset email (security template — always sends).
    console.log("📧 Sending password reset email...");
    const emailResult = await sendTemplatedEmail({
      key: "password_reset",
      to: email,
      data: { userName, resetUrl, accountType },
    });
    if (!emailResult.sent) {
      console.error("❌ Password reset email failed:", emailResult.reason, emailResult.error?.message || "");
      // Still return success to user for security reasons (don't reveal if email exists)
      return res.json({
        success: true,
        message: "If an account with that email exists, a password reset link has been sent.",
      });
    }
    console.log("✅ Password reset email sent successfully to:", email);

    res.json({
      success: true,
      message: "Password reset email sent successfully",
    });
  } catch (error) {
    console.error("❌ Forgot password error:", error);
    console.error("Error details:", error.message);
    res.status(500).json({
      success: false,
      error: "Failed to send password reset email",
    });
  }
};

// Reset password
const resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;

    console.log("🔄 Password reset request received");
    console.log("📝 Token:", token ? `${token.substring(0, 10)}...` : "missing");
    console.log("📝 Password length:", password ? password.length : 0);

    if (!token || !password) {
      console.log("❌ Missing token or password");
      return res.status(400).json({
        success: false,
        error: "Token and password are required",
      });
    }

    if (String(password).length < 6) {
      return res.status(400).json({
        success: false,
        error: "Password must be at least 6 characters.",
      });
    }

    // Find user with valid reset token in all collections
    console.log("🔍 Searching for user with reset token...");
    let user = await prisma.user.findFirst({
      where: {
        resetToken: token,
        resetTokenExpiry: {
          gt: new Date(),
        },
      },
    });
    let userType = "user";

    if (!user) {
      user = await prisma.admin.findFirst({
        where: {
          resetToken: token,
          resetTokenExpiry: {
            gt: new Date(),
          },
        },
      });
      userType = "admin";
    }

    if (!user) {
      user = await prisma.vendor.findFirst({
        where: {
          resetToken: token,
          resetTokenExpiry: {
            gt: new Date(),
          },
        },
      });
      userType = "vendor";
    }

    if (!user) {
      user = await prisma.qCChecker.findFirst({
        where: {
          resetToken: token,
          resetTokenExpiry: {
            gt: new Date(),
          },
        },
      });
      userType = "checker";
    }

    if (!user) {
      console.log("❌ No user found with valid reset token");
      // Check if token exists but is expired
      const expiredUser = await prisma.vendor.findFirst({
        where: { resetToken: token },
      });
      if (expiredUser) {
        console.log("⏰ Token found but expired");
        console.log("Token expiry:", expiredUser.resetTokenExpiry);
        console.log("Current time:", new Date());
      }
      return res.status(400).json({
        success: false,
        error: "Invalid or expired reset token",
      });
    }

    console.log(`✅ User found: ${userType} - ${user.email || user.ownerEmail}`);
    console.log("📧 User ID:", user.id);

    // Hash new password
    console.log("🔐 Hashing new password...");
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    console.log("✅ Password hashed successfully");

    // Update user password in appropriate collection
    console.log(`💾 Updating ${userType} password in database...`);
    if (userType === "admin") {
      await prisma.admin.update({
        where: { id: user.id },
        data: {
          password: hashedPassword,
          resetToken: null,
          resetTokenExpiry: null,
        },
      });
    } else if (userType === "vendor") {
      const updatedVendor = await prisma.vendor.update({
        where: { id: user.id },
        data: {
          password: hashedPassword,
          resetToken: null,
          resetTokenExpiry: null,
        },
      });
      console.log("✅ Vendor password updated successfully");
      console.log("📧 Vendor email:", updatedVendor.email);
      console.log("🏢 Company:", updatedVendor.companyName);
    } else if (userType === "checker") {
      await prisma.qCChecker.update({
        where: { id: user.id },
        data: {
          password: hashedPassword,
          resetToken: null,
          resetTokenExpiry: null,
        },
      });
      console.log("✅ QC checker password updated successfully");
    } else {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          password: hashedPassword,
          resetToken: null,
          resetTokenExpiry: null,
        },
      });
    }

    console.log("✅ Password reset completed successfully");
    res.json({
      success: true,
      message: "Password reset successfully",
    });
  } catch (error) {
    console.error("❌ Reset password error:", error);
    console.error("Error details:", error.message);
    console.error("Stack trace:", error.stack);
    res.status(500).json({
      success: false,
      error: "Password reset failed",
    });
  }
};

// Get current user
const getCurrentUser = async (req, res) => {
  try {
    // Try to find user in users collection first
    let user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        email: true,
        name: true,
        title: true,
        middleName: true,
        whatsappNumber: true,
        image: true,
        isVerified: true,
        isActive: true,
        lastLogin: true,
        createdAt: true,
        phoneNumber: true,
        address: true,
        addressLine2: true,
        city: true,
        state: true,
        zipCode: true,
        country: true,
        dateOfBirth: true,
        gender: true,
      },
    });
    let userType = "user";

    // If not found in users, try admins collection
    if (!user) {
      user = await prisma.admin.findUnique({
        where: { id: req.userId },
        select: {
          id: true,
          email: true,
          name: true,
          image: true,
          isVerified: true,
          isActive: true,
          lastLogin: true,
          createdAt: true,
          phoneNumber: true,
          address: true,
          addressLine2: true,
          city: true,
          state: true,
          zipCode: true,
          country: true,
          dateOfBirth: true,
          currency: true,
          companyName: true,
          gstNumber: true,
          onboardingCompleted: true,
          // TEMPORARILY HIDDEN - timezone and dateFormat
          // timezone: true,
          // dateFormat: true,
          workingHours: {
            orderBy: {
              day: "asc",
            },
          },
        },
      });
      userType = "admin";
    }

    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    res.json({
      success: true,
      data: {
        ...user,
        role: userType,
      },
    });
  } catch (error) {
    console.error("Get current user error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get user data",
    });
  }
};

// Logout user
const logout = async (req, res) => {
  try {
    const userId = req.userId;
    const token = req.headers.authorization?.replace("Bearer ", "");
    const { fcmToken } = req.body; // Get FCM token from request body

    // Get user info before logout
    let user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true },
    });
    let userType = "user";

    if (!user) {
      user = await prisma.admin.findUnique({
        where: { id: userId },
        select: { email: true, name: true, fcmTokens: true },
      });
      userType = "admin";
    }

    // ✅ FIX: Remove FCM token from database on logout (only for admin)
    if (fcmToken && user && userType === 'admin') {
      try {
        const tokens = Array.isArray(user.fcmTokens) ? user.fcmTokens : [];
        const updatedTokens = tokens.filter(t => t.token !== fcmToken);

        await prisma.admin.update({
          where: { id: userId },
          data: { fcmTokens: updatedTokens },
        });

        console.log(`✅ FCM token removed on logout for ${userType}: ${user.name} - Remaining devices: ${updatedTokens.length}`);
      } catch (fcmError) {
        console.error('⚠️ Failed to remove FCM token on logout:', fcmError.message);
        // Continue with logout even if FCM removal fails
      }
    }

    // Remove session from tracking
    if (token) {
      await sessionManager.removeSession(userId, token);
    }

    // Clear httpOnly cookie
    res.clearCookie('token', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/'
    });

    // Destroy Express session if it exists
    if (req.session) {
      req.session.destroy((err) => {
        if (err) {
          console.error("Session destruction error:", err);
        }
      });
    }

    res.json({
      success: true,
      message: "Logged out successfully",
    });

  } catch (error) {
    console.error("Logout error:", error);
    res.status(500).json({
      success: false,
      error: "Logout failed",
    });
  }
};

// Update user profile
const updateProfile = async (req, res) => {
  try {
    const {
      name,
      email,
      gender,
      title,
      middleName,
      whatsappNumber,
      image,
      phoneNumber,
      address,
      addressLine2,
      city,
      state,
      zipCode,
      country,
      dateOfBirth,
      currency,
      companyName,
      gstNumber,
      workingHours,
    } = req.body;
    const userId = req.userId;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: "Name is required",
      });
    }

    // Email is editable — validate format and enforce uniqueness across users
    // (excluding the current account) before we allow the change.
    let normalizedEmail;
    if (email !== undefined && email !== null && String(email).trim() !== "") {
      normalizedEmail = String(email).trim().toLowerCase();
      const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
      if (!EMAIL_RE.test(normalizedEmail)) {
        return res.status(400).json({ success: false, error: "Enter a valid email address" });
      }
      const taken = await prisma.user.findFirst({
        where: { email: normalizedEmail, NOT: { id: userId } },
        select: { id: true },
      });
      if (taken) {
        return res.status(400).json({ success: false, error: "This email is already in use" });
      }
    }

    // Gender is optional; only accept the known values.
    let normalizedGender;
    if (gender !== undefined) {
      const g = String(gender).trim().toLowerCase();
      normalizedGender = ["male", "female", "other"].includes(g) ? g : null;
    }

    // Profile photos arrive as base64 data URIs from the browser — upload them
    // to Cloudinary and store the resulting URL (never the raw base64 in the DB).
    const resolvedImage =
      image !== undefined
        ? await resolveBase64InValue(image, { folder: "customers/photos" })
        : undefined;

    // Prepare update data
    const updateData = {
      name,
      ...(normalizedEmail !== undefined && { email: normalizedEmail }),
      ...(normalizedGender !== undefined && { gender: normalizedGender }),
      ...(title !== undefined && { title }),
      ...(middleName !== undefined && { middleName }),
      ...(whatsappNumber !== undefined && { whatsappNumber }),
      ...(resolvedImage !== undefined && { image: resolvedImage }),
      ...(phoneNumber !== undefined && { phoneNumber }),
      ...(address !== undefined && { address }),
      ...(addressLine2 !== undefined && { addressLine2 }),
      ...(city !== undefined && { city }),
      ...(state !== undefined && { state }),
      ...(zipCode !== undefined && { zipCode }),
      ...(country !== undefined && { country }),
      ...(dateOfBirth && { dateOfBirth: new Date(dateOfBirth) }),
      ...(currency !== undefined && { currency }),
      ...(companyName !== undefined && { companyName }),
      ...(gstNumber !== undefined && { gstNumber }),
    };

    // Try to update in users collection first
    let updatedUser;
    let userType = "user";

    try {
      updatedUser = await prisma.user.update({
        where: { id: userId },
        data: updateData,
        select: {
          id: true,
          email: true,
          name: true,
          title: true,
          middleName: true,
          whatsappNumber: true,
          image: true,
          isVerified: true,
          isActive: true,
          provider: true,
          phoneNumber: true,
          address: true,
          addressLine2: true,
          city: true,
          state: true,
          zipCode: true,
          country: true,
          dateOfBirth: true,
          gender: true,
          createdAt: true,
        },
      });

      // Sync profile information to Customer collection for regular users
      try {
        console.log("🔄 Syncing user profile to customer collection...");

        // Check if customer record exists
        const existingCustomer = await prisma.customer.findUnique({
          where: { userId },
        });

        if (existingCustomer) {
          // Update existing customer record
          await prisma.customer.update({
            where: { userId },
            data: {
              name: updatedUser.name,
              image: updatedUser.image,
              phoneNumber: updatedUser.phoneNumber,
              address: updatedUser.address,
              addressLine2: updatedUser.addressLine2,
              city: updatedUser.city,
              state: updatedUser.state,
              zipCode: updatedUser.zipCode,
              country: updatedUser.country,
              dateOfBirth: updatedUser.dateOfBirth,
              syncedAt: new Date(),
            },
          });
          console.log("✅ Customer profile updated successfully");
        } else {
          // Create new customer record if it doesn't exist
          await prisma.customer.create({
            data: {
              userId: updatedUser.id,
              email: updatedUser.email,
              name: updatedUser.name,
              image: updatedUser.image,
              phoneNumber: updatedUser.phoneNumber,
              address: updatedUser.address,
              addressLine2: updatedUser.addressLine2,
              city: updatedUser.city,
              state: updatedUser.state,
              zipCode: updatedUser.zipCode,
              country: updatedUser.country,
              dateOfBirth: updatedUser.dateOfBirth,
              isVerified: updatedUser.isVerified,
              provider: updatedUser.provider || 'local',
              totalOrders: 0,
              totalSpent: 0,
              syncedAt: new Date(),
            },
          });
          console.log("✅ Customer record created successfully");
        }
      } catch (customerSyncError) {
        console.error("⚠️ Failed to sync customer profile:", customerSyncError);
        // Don't fail the main update if customer sync fails
      }

    } catch (error) {
      // If not found in users, try admins collection
      // Handle working hours for admin users
      if (workingHours && Array.isArray(workingHours)) {
        // First, delete existing working hours
        await prisma.workingHour.deleteMany({
          where: { adminId: userId },
        });

        // Create new working hours
        const workingHoursData = workingHours.map((wh) => ({
          adminId: userId,
          day: wh.day,
          enabled: wh.enabled,
          startTime: wh.startTime,
          endTime: wh.endTime,
        }));

        await prisma.workingHour.createMany({
          data: workingHoursData,
        });
      }

      // Check if trying to update immutable fields after onboarding
      const admin = await prisma.admin.findUnique({
        where: { id: userId },
        select: { onboardingCompleted: true },
      });

      if (admin?.onboardingCompleted) {
        // Prevent updates to immutable fields
        if (currency !== undefined || country !== undefined) {
          return res.status(400).json({
            success: false,
            error: "Currency and country cannot be changed after onboarding completion",
          });
        }
      }

      updatedUser = await prisma.admin.update({
        where: { id: userId },
        data: updateData,
        select: {
          id: true,
          email: true,
          name: true,
          image: true,
          isVerified: true,
          isActive: true,
          phoneNumber: true,
          address: true,
          addressLine2: true,
          city: true,
          state: true,
          zipCode: true,
          country: true,
          dateOfBirth: true,
          currency: true,
          companyName: true,
          gstNumber: true,
          onboardingCompleted: true,
          // TEMPORARILY HIDDEN - timezone and dateFormat
          // timezone: true,
          // dateFormat: true,
          workingHours: {
            orderBy: {
              day: "asc",
            },
          },
        },
      });
      userType = "admin";
    }

    res.json({
      success: true,
      message: "Profile updated successfully",
      data: {
        ...updatedUser,
        role: userType,
      },
    });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update profile",
    });
  }
};

// Google OAuth Success Handler
const googleAuthSuccess = async (req, res) => {
  try {
    if (!req.user) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/signin?error=auth_failed`
      );
    }

    // Check if login was initiated from admin page but user is not admin
    const loginSource = req.query.state;
    if (loginSource === 'admin' && req.user.role !== 'admin') {
      console.log(`⚠️ Non-admin user ${req.user.email} tried Google login from admin page`);
      return res.redirect(
        `${process.env.FRONTEND_URL}/admin/login?error=access_denied`
      );
    }

    // Generate JWT token
    const token = generateToken(req.user.id);

    // Track active session
    await sessionManager.addSession(req.user.id, token);

    // Set httpOnly cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/'
    });

    // Redirect to frontend with token (for backward compatibility)
    const redirectUrl = `${process.env.FRONTEND_URL
      }/auth/google/success?token=${token}&user=${encodeURIComponent(
        JSON.stringify({
          id: req.user.id,
          email: req.user.email,
          name: req.user.name,
          role: req.user.role,
          image: req.user.image,
          isVerified: req.user.isVerified,
        })
      )}`;

    res.redirect(redirectUrl);
  } catch (error) {
    console.error("Google auth success error:", error);
    res.redirect(`${process.env.FRONTEND_URL}/signin?error=auth_failed`);
  }
};

// Google OAuth Failure Handler
const googleAuthFailure = (req, res) => {
  res.redirect(`${process.env.FRONTEND_URL}/signin?error=auth_cancelled`);
};

// ============================================
// Address Management
// Schema fields: type, name, phone, address, addressLine2, city, state, zipCode, country, isDefault
// Business rules: max 3 addresses per user, exactly one default when user has any addresses.
// ============================================

const MAX_ADDRESSES_PER_USER = 3;
const ADDRESS_TYPES = ["home", "work", "other"];
const DEFAULT_COUNTRY_ISO = "IN";

const { Country, State } = require("country-state-city");
const { isValidPhoneNumber, parsePhoneNumberFromString } = require("libphonenumber-js");

// Mirror of frontend POSTAL_CODE_RULES — keep in sync with constants.ts.
// Falls back to a generic 3-12 alphanumeric check for unlisted countries.
const POSTAL_CODE_RULES = {
  US: /^\d{5}(-\d{4})?$/,
  IN: /^[1-9]\d{5}$/,
  GB: /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i,
  CA: /^[A-CEGHJ-NPR-TVXY]\d[A-CEGHJ-NPR-TV-Z]\s*\d[A-CEGHJ-NPR-TV-Z]\d$/i,
  AU: /^\d{4}$/,
  DE: /^\d{5}$/,
  FR: /^\d{5}$/,
  IT: /^\d{5}$/,
  ES: /^\d{5}$/,
  NL: /^\d{4}\s?[A-Z]{2}$/i,
  BR: /^\d{5}-?\d{3}$/,
  MX: /^\d{5}$/,
  JP: /^\d{3}-?\d{4}$/,
  CN: /^\d{6}$/,
  SG: /^\d{6}$/,
  AE: /^.{3,10}$/,
  SA: /^\d{5}(-?\d{4})?$/,
  ZA: /^\d{4}$/,
  NZ: /^\d{4}$/,
  CH: /^\d{4}$/,
  SE: /^\d{3}\s?\d{2}$/,
  NO: /^\d{4}$/,
  DK: /^\d{4}$/,
  FI: /^\d{5}$/,
  IE: /^[A-Z]\d{2}\s?[A-Z\d]{4}$/i,
  BE: /^\d{4}$/,
  AT: /^\d{4}$/,
  PL: /^\d{2}-\d{3}$/,
  PT: /^\d{4}-\d{3}$/,
  KR: /^\d{5}$/,
  RU: /^\d{6}$/,
};
const FALLBACK_POSTAL_REGEX = /^[A-Za-z0-9\s\-]{3,12}$/;

function normalizeCountryToIso(value) {
  if (!value) return DEFAULT_COUNTRY_ISO;
  const trimmed = String(value).trim();
  if (!trimmed) return DEFAULT_COUNTRY_ISO;
  const upper = trimmed.toUpperCase();
  const byIso = Country.getCountryByCode(upper);
  if (byIso) return byIso.isoCode;
  const byName = Country.getAllCountries().find(
    (c) => c.name.toLowerCase() === trimmed.toLowerCase()
  );
  return byName ? byName.isoCode : DEFAULT_COUNTRY_ISO;
}

function validatePostalCode(value, countryIso) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return false;
  const rule = POSTAL_CODE_RULES[countryIso] || FALLBACK_POSTAL_REGEX;
  return rule.test(trimmed);
}

function validatePhone(value, countryIso) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return false;
  try {
    return isValidPhoneNumber(trimmed, countryIso);
  } catch {
    return false;
  }
}

function toE164(value, countryIso) {
  const trimmed = String(value || "").trim();
  try {
    const parsed = parsePhoneNumberFromString(trimmed, countryIso);
    return parsed ? parsed.number : trimmed;
  } catch {
    return trimmed;
  }
}

function validateAddressPayload(body) {
  const {
    type,
    name,
    phone,
    phone2,
    landline,
    address,
    addressLine2,
    addressLine3,
    landmark,
    city,
    state,
    zipCode,
    country,
  } = body || {};

  if (!type || !ADDRESS_TYPES.includes(String(type).toLowerCase())) {
    return "Address type must be home, work, or other";
  }
  if (!name || !String(name).trim()) return "Name is required";
  if (String(name).trim().length > 80) return "Name must be 80 characters or less";

  const countryIso = normalizeCountryToIso(country);
  if (!Country.getCountryByCode(countryIso)) return "Invalid country";

  if (!phone || !String(phone).trim()) return "Phone is required";
  if (!validatePhone(phone, countryIso)) {
    const countryName = Country.getCountryByCode(countryIso)?.name || "selected country";
    return `Enter a valid phone number for ${countryName}`;
  }

  // Secondary phone is optional; when present it must be a valid mobile number.
  if (phone2 && String(phone2).trim()) {
    if (!validatePhone(phone2, countryIso)) {
      const countryName = Country.getCountryByCode(countryIso)?.name || "selected country";
      return `Enter a valid secondary phone number for ${countryName}`;
    }
  }

  // Landline is optional and free-form (STD/area code + number); loose digit check.
  if (landline && String(landline).trim()) {
    const digits = String(landline).replace(/\D/g, "");
    if (digits.length < 6 || digits.length > 15) return "Enter a valid landline number";
  }

  if (!address || String(address).trim().length < 3) return "Address is required (min 3 chars)";
  if (String(address).trim().length > 100) return "Address must be 100 characters or less";
  if (addressLine2 && String(addressLine2).length > 100) return "Address Line 2 too long";
  if (addressLine3 && String(addressLine3).length > 100) return "Address Line 3 too long";
  if (landmark && String(landmark).length > 100) return "Landmark must be 100 characters or less";

  if (!city || !String(city).trim()) return "City is required";
  if (String(city).trim().length > 50) return "City must be 50 characters or less";

  if (!state || !String(state).trim()) return "State / region is required";
  const stateList = State.getStatesOfCountry(countryIso) || [];
  if (stateList.length > 0) {
    const stateUpper = String(state).trim().toUpperCase();
    const validState = stateList.some(
      (s) => s.isoCode.toUpperCase() === stateUpper || s.name.toLowerCase() === String(state).trim().toLowerCase()
    );
    if (!validState) return "Select a valid state / province";
  } else if (String(state).trim().length > 50) {
    return "State / region must be 50 characters or less";
  }

  if (!zipCode || !validatePostalCode(zipCode, countryIso)) {
    return "Enter a valid postal code";
  }

  return null;
}

function normalizeAddressData(body) {
  const countryIso = normalizeCountryToIso(body.country);
  const phoneE164 = toE164(body.phone, countryIso);
  // Canonicalize state to its ISO code when the country has a known state list,
  // accepting either the ISO code or full name as input. Free-text regions are
  // preserved as-is so non-Latin / accented names (e.g. "Île-de-France") survive.
  const stateList = State.getStatesOfCountry(countryIso) || [];
  const stateValue = String(body.state).trim();
  let canonicalState = stateValue;
  if (stateList.length > 0 && stateValue) {
    const upper = stateValue.toUpperCase();
    const byCode = stateList.find((s) => s.isoCode.toUpperCase() === upper);
    const byName = stateList.find((s) => s.name.toLowerCase() === stateValue.toLowerCase());
    canonicalState = (byCode || byName)?.isoCode ?? stateValue.toUpperCase();
  }
  // Office/company name (work) or custom label (other); ignored for home.
  const addrType = String(body.type).toLowerCase();
  const typeLabel = (addrType === "work" || addrType === "other") && body.typeLabel
    ? String(body.typeLabel).trim().slice(0, 80)
    : "";
  return {
    type: addrType,
    typeLabel,
    name: String(body.name).trim(),
    phone: phoneE164,
    phone2: body.phone2 && String(body.phone2).trim() ? toE164(body.phone2, countryIso) : "",
    landline: body.landline ? String(body.landline).trim() : "",
    address: String(body.address).trim(),
    addressLine2: body.addressLine2 ? String(body.addressLine2).trim() : "",
    addressLine3: body.addressLine3 ? String(body.addressLine3).trim() : "",
    landmark: body.landmark ? String(body.landmark).trim() : "",
    city: String(body.city).trim(),
    state: canonicalState,
    zipCode: String(body.zipCode).trim().toUpperCase(),
    country: countryIso,
  };
}

// Get user addresses
const getAddresses = async (req, res) => {
  try {
    const userId = req.userId;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    const addresses = await prisma.address.findMany({
      where: { userId },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
    });

    res.json({ success: true, data: addresses });
  } catch (error) {
    console.error("Get addresses error:", error);
    res.status(500).json({ success: false, error: "Failed to get addresses" });
  }
};

// Add new address
const addAddress = async (req, res) => {
  try {
    const userId = req.userId;

    const validationError = validateAddressPayload(req.body);
    if (validationError) {
      return res.status(400).json({ success: false, error: validationError });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    const existingCount = await prisma.address.count({ where: { userId } });
    if (existingCount >= MAX_ADDRESSES_PER_USER) {
      return res.status(400).json({
        success: false,
        error: `You can save up to ${MAX_ADDRESSES_PER_USER} addresses. Please delete one before adding a new one.`,
      });
    }

    const data = normalizeAddressData(req.body);
    const requestedDefault = !!req.body.isDefault;
    // First address is always default; otherwise honor requested flag.
    const shouldBeDefault = existingCount === 0 || requestedDefault;

    const newAddress = await prisma.$transaction(async (tx) => {
      if (shouldBeDefault) {
        await tx.address.updateMany({
          where: { userId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.address.create({
        data: { ...data, userId, isDefault: shouldBeDefault },
      });
    });

    res.status(201).json({
      success: true,
      message: "Address added successfully",
      data: newAddress,
    });
  } catch (error) {
    console.error("Add address error:", error);
    res.status(500).json({ success: false, error: "Failed to add address" });
  }
};

// Update existing address
const updateAddress = async (req, res) => {
  try {
    const userId = req.userId;
    const addressId = req.params.id;

    const validationError = validateAddressPayload(req.body);
    if (validationError) {
      return res.status(400).json({ success: false, error: validationError });
    }

    const existingAddress = await prisma.address.findFirst({
      where: { id: addressId, userId },
    });
    if (!existingAddress) {
      return res.status(404).json({
        success: false,
        error: "Address not found or access denied",
      });
    }

    const data = normalizeAddressData(req.body);
    const wantsDefault = req.body.isDefault === true;
    // If this address is currently the only default and caller passes false, still keep it default
    // to preserve the "exactly one default" invariant.
    const keepAsDefault = existingAddress.isDefault && !wantsDefault
      ? (await prisma.address.count({ where: { userId, isDefault: true, NOT: { id: addressId } } })) === 0
      : false;
    const shouldBeDefault = wantsDefault || keepAsDefault;

    const updatedAddress = await prisma.$transaction(async (tx) => {
      if (shouldBeDefault) {
        await tx.address.updateMany({
          where: { userId, isDefault: true, NOT: { id: addressId } },
          data: { isDefault: false },
        });
      }
      return tx.address.update({
        where: { id: addressId },
        data: { ...data, isDefault: shouldBeDefault || existingAddress.isDefault },
      });
    });

    res.json({
      success: true,
      message: "Address updated successfully",
      data: updatedAddress,
    });
  } catch (error) {
    console.error("Update address error:", error);
    res.status(500).json({ success: false, error: "Failed to update address" });
  }
};

// Delete address. If deleting the default, promote the most recently updated remaining address.
const deleteAddress = async (req, res) => {
  try {
    const userId = req.userId;
    const addressId = req.params.id;

    const existingAddress = await prisma.address.findFirst({
      where: { id: addressId, userId },
    });
    if (!existingAddress) {
      return res.status(404).json({
        success: false,
        error: "Address not found or access denied",
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.address.delete({ where: { id: addressId } });

      if (existingAddress.isDefault) {
        const nextDefault = await tx.address.findFirst({
          where: { userId },
          orderBy: { updatedAt: "desc" },
        });
        if (nextDefault) {
          await tx.address.update({
            where: { id: nextDefault.id },
            data: { isDefault: true },
          });
        }
      }
    });

    res.json({ success: true, message: "Address deleted successfully" });
  } catch (error) {
    console.error("Delete address error:", error);
    res.status(500).json({ success: false, error: "Failed to delete address" });
  }
};

// Set a specific address as default
const setDefaultAddress = async (req, res) => {
  try {
    const userId = req.userId;
    const addressId = req.params.id;

    const existingAddress = await prisma.address.findFirst({
      where: { id: addressId, userId },
    });
    if (!existingAddress) {
      return res.status(404).json({
        success: false,
        error: "Address not found or access denied",
      });
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.address.updateMany({
        where: { userId, isDefault: true, NOT: { id: addressId } },
        data: { isDefault: false },
      });
      return tx.address.update({
        where: { id: addressId },
        data: { isDefault: true },
      });
    });

    res.json({
      success: true,
      message: "Default address updated",
      data: updated,
    });
  } catch (error) {
    console.error("Set default address error:", error);
    res.status(500).json({ success: false, error: "Failed to set default address" });
  }
};

// Complete admin onboarding (one-time setup)
const completeOnboarding = async (req, res) => {
  try {
    const userId = req.userId;
    const {
      name,
      phoneNumber,
      companyName,
      gstNumber,
      address,
      city,
      state,
      zipCode,
      country,
      currency,
      timezone,
      dateFormat,
    } = req.body;

    // Validation - Required fields
    // TEMPORARILY HIDDEN - timezone and dateFormat validation
    // if (!name || !phoneNumber || !companyName || !address || !state || !country || !currency || !timezone || !dateFormat) {
    if (!name || !phoneNumber || !companyName || !address || !state || !country || !currency) {
      return res.status(400).json({
        success: false,
        error: "All required onboarding fields must be provided",
      });
    }

    // Find admin
    const admin = await prisma.admin.findUnique({
      where: { id: userId },
    });

    if (!admin) {
      return res.status(404).json({
        success: false,
        error: "Admin not found",
      });
    }

    // Check if onboarding already completed
    if (admin.onboardingCompleted) {
      return res.status(400).json({
        success: false,
        error: "Onboarding already completed. Immutable settings cannot be changed.",
      });
    }

    // Update admin with onboarding data
    const updatedAdmin = await prisma.admin.update({
      where: { id: userId },
      data: {
        name,
        phoneNumber,
        companyName,
        gstNumber: gstNumber || null,
        address,
        city: city || null,
        state,
        zipCode: zipCode || null,
        country,
        currency,
        // TEMPORARILY HIDDEN - timezone and dateFormat
        // timezone,
        // dateFormat,
        onboardingCompleted: true,
      },
      select: {
        id: true,
        email: true,
        name: true,
        image: true,
        isVerified: true,
        isActive: true,
        phoneNumber: true,
        address: true,
        city: true,
        state: true,
        zipCode: true,
        country: true,
        dateOfBirth: true,
        currency: true,
        companyName: true,
        gstNumber: true,
        onboardingCompleted: true,
        // TEMPORARILY HIDDEN - timezone and dateFormat
        // timezone: true,
        // dateFormat: true,
        workingHours: {
          orderBy: {
            day: "asc",
          },
        },
      },
    });

    res.json({
      success: true,
      message: "Onboarding completed successfully",
      data: {
        ...updatedAdmin,
        role: "admin",
      },
    });
  } catch (error) {
    console.error("Complete onboarding error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to complete onboarding",
    });
  }
};

// Get admin settings for other services
const getAdminSettings = async (req, res) => {
  try {
    // Get first active admin
    const admin = await prisma.admin.findFirst({
      where: {
        isActive: true,
        isVerified: true,
      },
      select: {
        currency: true,
        companyName: true,
        gstNumber: true,
        address: true,
        city: true,
        state: true,
        zipCode: true,
        country: true,
      },
    });

    if (!admin) {
      return res.status(404).json({
        success: false,
        error: "Admin not found",
      });
    }

    // Format billing address
    const billingAddress = [
      admin.address,
      admin.city,
      admin.state,
      admin.zipCode,
      admin.country,
    ]
      .filter(Boolean)
      .join(", ");

    res.json({
      success: true,
      data: {
        currency: admin.currency || "INR",
        companyName: admin.companyName || "",
        gstNumber: admin.gstNumber || "",
        address: admin.address || "",
        city: admin.city || "",
        state: admin.state || "",
        zipCode: admin.zipCode || "",
        country: admin.country || "",
        billingAddress,
      },
    });
  } catch (error) {
    console.error("Get admin settings error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get admin settings",
    });
  }
};

// Get user statistics
const getUserStats = async (req, res) => {
  try {
    const userId = req.userId;

    // Find user in both collections to determine user type
    let user = await prisma.user.findUnique({
      where: { id: userId },
    });
    let userType = "user";

    if (!user) {
      user = await prisma.admin.findUnique({
        where: { id: userId },
      });
      userType = "admin";
    }

    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    // For admin users, return basic stats
    if (userType === "admin") {
      return res.json({
        success: true,
        data: {
          accountType: "admin",
          memberSince: user.createdAt,
          lastLogin: user.lastLogin,
          isVerified: user.isVerified,
        },
      });
    }

    // For regular users, get comprehensive stats
    try {
      // Get customer record for order stats
      const customer = await prisma.customer.findUnique({
        where: { userId },
      });

      // Get online orders
      const onlineOrders = await prisma.onlineOrder.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
      });

      // Get POS orders if customer exists
      let posOrders = [];
      if (customer) {
        posOrders = await prisma.pOSOrder.findMany({
          where: { customerId: customer.id },
          orderBy: { createdAt: "desc" },
        });
      }

      // Calculate comprehensive stats
      const allOrders = [...onlineOrders, ...posOrders];
      const totalOrders = allOrders.length;
      const totalSpent = allOrders.reduce((sum, order) => sum + order.total, 0);
      const completedOrders = allOrders.filter(order =>
        order.orderStatus === 'delivered' || order.orderStatus === 'completed'
      ).length;
      const pendingOrders = allOrders.filter(order =>
        ['pending', 'confirmed', 'processing', 'shipped'].includes(order.orderStatus)
      ).length;
      const cancelledOrders = allOrders.filter(order =>
        order.orderStatus === 'cancelled'
      ).length;
      const averageOrderValue = totalOrders > 0 ? totalSpent / totalOrders : 0;
      const lastOrderDate = allOrders.length > 0 ? allOrders[0].createdAt : null;

      // Get recent orders (last 5)
      const recentOrders = allOrders.slice(0, 5).map(order => ({
        id: order.id,
        orderNumber: order.orderNumber,
        orderType: order.orderType,
        total: order.total,
        orderStatus: order.orderStatus,
        createdAt: order.createdAt,
        itemCount: Array.isArray(order.items) ? order.items.length : 0,
      }));

      const stats = {
        accountType: "user",
        memberSince: user.createdAt,
        lastLogin: user.lastLogin,
        isVerified: user.isVerified,
        totalOrders,
        totalSpent,
        completedOrders,
        pendingOrders,
        cancelledOrders,
        averageOrderValue,
        lastOrderDate,
        recentOrders,
        // Wishlist and cart stats
        wishlistItems: customer ? await prisma.wishlistItem.count({
          where: { customerId: customer.id }
        }) : 0,
        cartItems: customer ? await prisma.cart.count({
          where: { customerId: customer.id }
        }) : 0,
      };

      res.json({
        success: true,
        data: stats,
      });
    } catch (error) {
      console.error("Error calculating user stats:", error);
      // Return basic stats if detailed calculation fails
      res.json({
        success: true,
        data: {
          accountType: "user",
          memberSince: user.createdAt,
          lastLogin: user.lastLogin,
          isVerified: user.isVerified,
          totalOrders: 0,
          totalSpent: 0,
          completedOrders: 0,
          pendingOrders: 0,
          cancelledOrders: 0,
          averageOrderValue: 0,
          lastOrderDate: null,
          recentOrders: [],
          wishlistItems: 0,
          cartItems: 0,
        },
      });
    }
  } catch (error) {
    console.error("Get user stats error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get user statistics",
    });
  }
};

// Super Admin Login - Dedicated endpoint for admin dashboard
const superAdminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: "Email and password are required",
      });
    }

    console.log(`🔍 Super Admin login attempt: ${email}`);

    // Only check admin collection for super admin login
    const admin = await prisma.admin.findUnique({
      where: { email },
      include: { role: true }
    });

    if (!admin) {
      console.log("❌ Admin not found");
      return res.status(401).json({
        success: false,
        error: "Invalid admin credentials",
      });
    }

    // Check if admin is active
    if (!admin.isActive) {
      console.log("❌ Admin account is deactivated");
      return res.status(401).json({
        success: false,
        error: "Admin account is deactivated. Please contact system administrator.",
      });
    }

    // Maker-checker: a newly created staff account cannot log in until approved.
    if (admin.approvalStatus && admin.approvalStatus !== "APPROVED") {
      console.log("❌ Admin account is awaiting approval / was rejected");
      return res.status(403).json({
        success: false,
        error: admin.approvalStatus === "REJECTED"
          ? "Your staff account was not approved. Please contact your administrator."
          : "Your staff account is awaiting approval. You'll be able to sign in once it's approved.",
      });
    }

    // For Google OAuth admins without password
    if (admin.provider === "google" && !admin.password) {
      console.log("❌ Google OAuth admin trying to login with password");
      return res.status(409).json({
        success: false,
        code: "GOOGLE_ACCOUNT",
        error: "This admin account uses Google sign-in. Please continue with Google, or use 'Forgot Password' to set a password for email login.",
      });
    }

    // Verify password
    if (!admin.password) {
      console.log("❌ Admin has no password set");
      return res.status(401).json({
        success: false,
        error: "Invalid admin credentials",
      });
    }

    const isPasswordValid = await bcrypt.compare(password, admin.password);
    if (!isPasswordValid) {
      console.log("❌ Invalid password");
      return res.status(401).json({
        success: false,
        error: "Invalid admin credentials",
      });
    }

    // Email verification gate — staff created by an admin must click the
    // verification link emailed to them before they can log in. The default
    // bootstrap admin (`initializeAdmin`) is already `isVerified: true`, so
    // this does not affect existing Super Admin logins.
    if (!admin.isVerified) {
      console.log("❌ Admin email not verified");
      return res.status(403).json({
        success: false,
        code: 'EMAIL_NOT_VERIFIED',
        error: "Please verify your email first. Check your inbox for the verification link.",
      });
    }

    // Update last login
    await prisma.admin.update({
      where: { id: admin.id },
      data: { lastLogin: new Date() },
    });

    // Generate token
    const token = generateToken(admin.id);

    // Track active session
    await sessionManager.addSession(admin.id, token);

    // Set httpOnly cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/'
    });

    console.log(`✅ Super Admin login successful: ${admin.name}`);

    res.json({
      success: true,
      message: "Super Admin login successful",
      data: {
        token, // Still send in response for backward compatibility
        user: {
          id: admin.id,
          email: admin.email,
          name: admin.name,
          role: "admin", // Explicitly set role as admin
          image: admin.image,
          isVerified: admin.isVerified,
          phoneNumber: admin.phoneNumber,
          address: admin.address,
          addressLine2: admin.addressLine2,
          city: admin.city,
          state: admin.state,
          zipCode: admin.zipCode,
          country: admin.country,
          dateOfBirth: admin.dateOfBirth,
          currency: admin.currency,
          companyName: admin.companyName,
          gstNumber: admin.gstNumber,
          onboardingCompleted: admin.onboardingCompleted,
          // Include role info so the frontend can do permission checks
          roleName: admin.role ? admin.role.name : 'admin',
          permissions: admin.role ? admin.role.permissions : []
        },
      },
    });
  } catch (error) {
    console.error("Super Admin login error:", error);
    res.status(500).json({
      success: false,
      error: "Super Admin login failed",
    });
  }
};

module.exports = {
  register,
  login,
  superAdminLogin,
  googleCallback,
  verifyEmail,
  forgotPassword,
  resetPassword,
  getCurrentUser,
  logout,
  updateProfile,
  googleAuthSuccess,
  googleAuthFailure,
  completeOnboarding,
  getAdminSettings,
  getAddresses,
  addAddress,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
  getUserStats,
};
