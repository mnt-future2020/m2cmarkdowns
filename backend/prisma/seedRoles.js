const { PrismaClient } = require('@prisma/client');
const {
    availablePermissions,
    VALID_PERMISSION_NAMES,
    LEGACY_PERMISSION_MAP,
} = require('../config/permissions');

const prisma = new PrismaClient();

const ALL_PERMISSIONS = availablePermissions.map(p => p.name);

const defaultRoles = [
    {
        name: 'Super Admin',
        description: 'Full system access with all permissions',
        isSystem: true,
        // Super Admin bypasses permission checks via role name match. We still
        // list every permission so the UI shows the full set when admins view
        // this role, and this array stays in sync with the catalog.
        permissions: ALL_PERMISSIONS,
    },
    {
        name: 'Admin',
        description: 'Administrative access with limited permissions',
        isSystem: true,
        permissions: [
            // Vendors
            'vendor_management:view', 'vendor_management:create', 'vendor_management:edit',
            'vendor_management:approve', 'vendor_management:suspend',
            'assign_qc_checker:view', 'assign_qc_checker:create', 'assign_qc_checker:edit',
            'vendor_product_requests:view', 'vendor_product_requests:edit',
            'vendor_product_requests:approve', 'vendor_product_requests:assign_qc',
            'vendor_to_hub:view', 'vendor_to_hub:edit', 'vendor_to_hub:update_status',
            'settlement:view',
            'vendor_product_reviews:view',
            // Customers
            'customer_management:view', 'customer_management:suspend',
            'hub_to_customer:view', 'hub_to_customer:edit', 'hub_to_customer:update_status',
            'invoices:view', 'invoices:print',
            'customer_reviews:view', 'customer_reviews:approve',
            // Admin
            'qc_checker_management:view', 'qc_checker_management:create', 'qc_checker_management:edit',
            'qc_checker_management:resend_credentials',
            'qc_reports:view',
            'reinspection_review:view', 'reinspection_review:approve',
            'all_products:view', 'all_products:create', 'all_products:edit', 'all_products:delete',
            'all_products:approve',
            'categories:view', 'categories:create', 'categories:edit', 'categories:delete',
            'inventory:view', 'inventory:create', 'inventory:edit', 'inventory:update_stock',
            'coupons:view', 'coupons:create', 'coupons:edit',
            'staff_management:view', 'staff_management:create', 'staff_management:edit',
            'staff_management:suspend',
            'roles_permissions:view',
            'analytics:view',
            'reports:view', 'reports:export',
            'support:view', 'support:edit',
            'vendor_enquiries:view', 'vendor_enquiries:approve',
            'website_enquiries:view', 'website_enquiries:resolve',
            'settings:view',
        ],
    },
    {
        name: 'Manager',
        description: 'Management access for products and orders',
        // Editable role: admins can tune the Manager permission set (unlike the
        // protected Super Admin / Admin system roles).
        isSystem: false,
        permissions: [
            'all_products:view', 'all_products:create', 'all_products:edit', 'all_products:approve',
            'vendor_product_requests:view',
            'vendor_to_hub:view', 'vendor_to_hub:edit', 'vendor_to_hub:update_status',
            'hub_to_customer:view', 'hub_to_customer:edit', 'hub_to_customer:update_status',
            'invoices:view', 'invoices:print',
            'settlement:view',
            'reports:view',
            'qc_reports:view',
            'analytics:view',
            'support:view',
        ],
    },
];

// Translate a stored permission list (possibly in the retired flat scheme)
// into the current `submodule:action` scheme.
function migratePermissions(perms) {
    const out = new Set();
    for (const p of perms || []) {
        if (VALID_PERMISSION_NAMES.has(p)) {
            out.add(p);
        } else if (LEGACY_PERMISSION_MAP[p]) {
            LEGACY_PERMISSION_MAP[p].forEach(np => out.add(np));
        }
        // Unknown strings are dropped.
    }
    return [...out];
}

async function main() {
    console.log('Seeding roles...');

    for (const roleData of defaultRoles) {
        const role = await prisma.role.upsert({
            where: { name: roleData.name },
            update: {
                permissions: roleData.permissions,
                description: roleData.description,
                // Respect each role's own flag so editable roles (Manager) aren't
                // re-locked on re-seed.
                isSystem: roleData.isSystem === true,
                // Seeded/system roles are pre-approved — they must never be held
                // pending (that would make them unassignable and lock out staff).
                approvalStatus: 'APPROVED'
            },
            create: { ...roleData, approvalStatus: 'APPROVED' }
        });
        console.log(`Upserted role: ${role.name}`);
    }

    // Migrate custom (non-system) roles still storing legacy permission names.
    const customRoles = await prisma.role.findMany({ where: { isSystem: false } });
    for (const role of customRoles) {
        const hasLegacy = (role.permissions || []).some(p => !VALID_PERMISSION_NAMES.has(p));
        if (!hasLegacy) continue;
        const migrated = migratePermissions(role.permissions);
        await prisma.role.update({
            where: { id: role.id },
            data: { permissions: migrated }
        });
        console.log(`Migrated role "${role.name}" to the new permission scheme (${migrated.length} permissions).`);
    }

    // Assign 'Super Admin' role to any existing admins without a role
    const superAdminRole = await prisma.role.findUnique({ where: { name: 'Super Admin' } });
    if (superAdminRole) {
        const result = await prisma.admin.updateMany({
            where: { roleId: null },
            data: { roleId: superAdminRole.id }
        });
        console.log(`Updated ${result.count} existing admin accounts to Super Admin role.`);
    }

    console.log('Role seeding completed successfully.');
}

main()
    .catch(e => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
