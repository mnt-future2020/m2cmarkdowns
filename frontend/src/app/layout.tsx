import type { Metadata } from "next";
import { Outfit, Poppins } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/UI/Toaster";
import { CenterNoticeHost } from "@/components/UI/CenterNotice";
import PageTracker from "@/components/Analytics/PageTracker";
import { ExchangeRateLoader } from "@/components/Shared/ExchangeRateLoader";
import DocViewerProvider from "@/components/Shared/DocViewerProvider";
import FaviconManager from "@/components/Shared/FaviconManager";

const outfit = Outfit({
  variable: "--font-outfit",
  subsets: ["latin"],
});

// Headings use Poppins. The variable name is kept as --font-playfair so every existing
// `font-playfair` usage across the site switches to Poppins with no per-component edits.
const playfair = Poppins({
  variable: "--font-playfair",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});

// Canonical site URL per storefront — used to make the social-share image an
// absolute URL (WhatsApp/Facebook/etc. require an absolute og:image).
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_REGION === "IN"
    ? "https://m2cmarkdowns.in"
    : "https://m2cmarkdowns.com";

const SITE_TITLE = "M2C-Direct From Manufacturer To Customer";
const SITE_DESCRIPTION =
  "Wholesale products directly from manufacturers to customers with M2C's streamlined platform.";

// Static default favicon rendered on the server for every route (consistent and
// cacheable). The *admin-uploaded* favicon is applied on the client by
// <FaviconManager/> so it stays in sync across all portals — fetching it here in
// generateMetadata cached a different stale value per route, which is exactly
// how the storefront and admin ended up showing different favicons.
const DEFAULT_ICONS: Metadata["icons"] = {
  icon: [{ url: "/assets/logo/m2c-logo.png" }],
  apple: [{ url: "/assets/logo/m2c-logo.png", sizes: "180x180" }],
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  icons: DEFAULT_ICONS,
  // The preview card shown when the site link is shared (WhatsApp, Facebook,
  // LinkedIn, iMessage, etc.). Replace /public/og-image.jpg (1200×630) to change
  // the image — no code change needed.
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "M2C MarkDowns",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [
      {
        url: "/og-image.jpg",
        width: 1200,
        height: 630,
        alt: "M2C MarkDowns — Direct From Manufacturer To Customer",
      },
    ],
  },
  // X/Twitter uses its own tags; summary_large_image shows the big preview card.
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: ["/og-image.jpg"],
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full">
      <body
        className={`${outfit.variable} ${playfair.variable} font-outfit antialiased h-full`}
        suppressHydrationWarning
      >
        <PageTracker />
        <ExchangeRateLoader />
        <FaviconManager />
        {children}
        <Toaster />
        {/* Centre-screen confirmations. Already mounted in the admin, vendor
            and checker layouts; the storefront had no host, so a call to
            centerNotice from a public page went nowhere. Renders null until
            something is showing. */}
        <CenterNoticeHost />
        <DocViewerProvider />
      </body>
    </html>
  );
}