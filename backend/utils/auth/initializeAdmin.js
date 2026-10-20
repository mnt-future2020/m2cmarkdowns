const bcrypt = require("bcryptjs");
const { prisma } = require("../../config/database");

/**
 * Auto-initialize admin user on first database connection
 * This runs automatically when the server starts
 */
async function initializeAdmin() {
  try {
    console.log("🔍 Checking admin initialization...");
    
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminEmail || !adminPassword) {
      console.log("⚠️  ADMIN_EMAIL and ADMIN_PASSWORD not set - skipping admin initialization");
      return { success: false, message: "Environment variables not set" };
    }

    // Check if admin already exists
    const existingAdmin = await prisma.admin.findUnique({
      where: { email: adminEmail },
    });

    if (existingAdmin) {
      console.log("✅ Admin user already exists");
      console.log(`   ID: ${existingAdmin.id}`);
      console.log(`   Email: ${existingAdmin.email}`);
      console.log(`   Name: ${existingAdmin.name}`);

      // Self-heal: if the default admin has no role, attach Super Admin
      // so they don't get locked out of permission-protected routes.
      if (!existingAdmin.roleId) {
        let superAdminRole = await prisma.role.findUnique({ where: { name: 'Super Admin' } });
        if (!superAdminRole) {
          superAdminRole = await prisma.role.create({
            data: {
              name: 'Super Admin',
              description: 'Full system access — bypasses all permission checks',
              permissions: [],
              isSystem: true,
              approvalStatus: 'APPROVED'
            }
          });
        }
        await prisma.admin.update({
          where: { id: existingAdmin.id },
          data: { roleId: superAdminRole.id }
        });
        console.log("✅ Existing default admin linked to 'Super Admin' role");
      }

      return { success: true, message: "Admin already exists", admin: existingAdmin };
    }

    console.log("🌱 Creating default admin user...");

    // Hash the admin password
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(adminPassword, saltRounds);

    // Make sure a "Super Admin" role exists so the default admin can use
    // permission-protected routes. Without this the RBAC middleware would 403 them.
    let superAdminRole = await prisma.role.findUnique({ where: { name: 'Super Admin' } });
    if (!superAdminRole) {
      superAdminRole = await prisma.role.create({
        data: {
          name: 'Super Admin',
          description: 'Full system access — bypasses all permission checks',
          permissions: [],
          isSystem: true
        }
      });
      console.log("✅ 'Super Admin' role seeded");
    }

    // Create admin user with Super Admin role attached
    const adminUser = await prisma.admin.create({
      data: {
        email: adminEmail,
        password: hashedPassword,
        name: "Admin User",
        isVerified: true,
        isActive: true,
        provider: "local",
        roleId: superAdminRole.id,
        approvalStatus: 'APPROVED',
      },
    });

    console.log("✅ Admin user created successfully!");
    console.log(`   ID: ${adminUser.id}`);
    console.log(`   Email: ${adminUser.email}`);
    console.log(`   Role: Super Admin`);

    // Create default working hours (24/7 operation)
    const existingWorkingHours = await prisma.workingHour.count({
      where: { adminId: adminUser.id }
    });

    if (existingWorkingHours === 0) {
      const defaultWorkingHours = [
        { day: "Monday", enabled: true, startTime: "00:00", endTime: "23:59" },
        { day: "Tuesday", enabled: true, startTime: "00:00", endTime: "23:59" },
        { day: "Wednesday", enabled: true, startTime: "00:00", endTime: "23:59" },
        { day: "Thursday", enabled: true, startTime: "00:00", endTime: "23:59" },
        { day: "Friday", enabled: true, startTime: "00:00", endTime: "23:59" },
        { day: "Saturday", enabled: true, startTime: "00:00", endTime: "23:59" },
        { day: "Sunday", enabled: true, startTime: "00:00", endTime: "23:59" },
      ];

      const workingHoursData = defaultWorkingHours.map((wh) => ({
        adminId: adminUser.id,
        day: wh.day,
        enabled: wh.enabled,
        startTime: wh.startTime,
        endTime: wh.endTime,
      }));

      await prisma.workingHour.createMany({
        data: workingHoursData
      });

      console.log("✅ Default working hours configured");
    }
    
    console.log(`📧 Email: ${adminEmail}`);
    
    return { success: true, message: "Admin created successfully", admin: adminUser };
  } catch (error) {
    console.error("❌ Error initializing admin user:");
    console.error("   Error name:", error.name);
    console.error("   Error message:", error.message);
    if (error.code) {
      console.error("   Error code:", error.code);
    }
    if (error.meta) {
      console.error("   Error meta:", JSON.stringify(error.meta, null, 2));
    }
    console.error("   Stack trace:", error.stack);
    
    // Return error info instead of throwing
    return { success: false, message: error.message, error };
  }
}

module.exports = { initializeAdmin };
