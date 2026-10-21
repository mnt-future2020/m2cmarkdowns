import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Tree-shake commonly-used libs with thousands of named exports so the
  // client bundle only ships the icons / utilities the app actually uses.
  // Tens of KB saved per chunk that imports from these packages.
  experimental: {
    optimizePackageImports: [
      'lucide-react',
      '@tabler/icons-react',
      'date-fns',
    ],
  },
  images: {
    // Use Cloudinary's own transformation pipeline instead of Vercel's
    // image optimizer.
    //
    // Why: Vercel's /_next/image service has a monthly quota of "optimized
    // image transformations" per account. On May 22 2026 we hit the cap and
    // started getting 402 Payment Required responses, breaking category
    // banners, subcategory cards, and product images across the site.
    //
    // Every customer-facing image already lives on Cloudinary. Cloudinary
    // supports URL-based transformations natively (f_auto for format
    // negotiation, q_auto for quality, w_<n> for responsive sizing) and
    // serves them from its own global CDN. Routing optimization through
    // Vercel as a middleman burned quota and added a hop for marginal —
    // sometimes negative — benefit.
    //
    // The custom loader rewrites Cloudinary URLs in place to add the
    // optimization parameters Next.js would have asked Vercel to do, and
    // passes any non-Cloudinary URL through unchanged. Result: same
    // responsive sizing and modern formats we had before, served from
    // Cloudinary directly, with no Vercel image quota usage.
    loader: 'custom',
    loaderFile: './src/lib/cloudinaryLoader.ts',
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'images.pexels.com',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'images.unsplash.com',
        port: '',
        pathname: '/**',
      },
      {
        // Legacy assets still on Cloudinary during the Spaces migration.
        protocol: 'https',
        hostname: 'res.cloudinary.com',
        port: '',
        pathname: '/**',
      },
      {
        // DigitalOcean Spaces — origin + CDN (any bucket/region subdomain).
        protocol: 'https',
        hostname: '**.digitaloceanspaces.com',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'http',
        hostname: 'localhost',
        port: '5001',
        pathname: '/**',
      },
    ],
  },
};

export default nextConfig;
