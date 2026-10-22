import type { Metadata } from "next";
import { Outfit, Poppins } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/UI/Toaster";
import { CenterNoticeHost } from "@/components/UI/CenterNotice";
import PageTracker from "@/components/Analytics/PageTracker";
import { ExchangeRateLoader } from "@/components/Shared/ExchangeRateLoader";
import DocViewerProvider from "@/components/Shared/DocViewerProvider";

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

// Default favicon, used when no favicon has been uploaded in admin Settings.
const DEFAULT_ICONS: Metadata["icons"] = {
  icon: [{ url: "/assets/logo/m2c-logo.png" }],
  apple: [{ url: "/assets/logo/m2c-logo.png", sizes: "180x180" }],
};

// Fetch the admin-uploaded favicon (Settings → Company → Favicon) from the
// public company-info endpoint. Falls back to the bundled default icons if none
// is set or the backend can't be reached. Cached briefly so every request
// doesn't hit the API — a freshly uploaded favicon appears within ~5 minutes
// (and immediately on the next cold render / deploy).
async function resolveIcons(): Promise<Metadata["icons"]> {
  try {
    const raw = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api").replace(/\/+$/, "");
    const apiBase = /\/api$/.test(raw) ? raw : `${raw}/api`;
    const res = await fetch(`${apiBase}/company-info/public`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return DEFAULT_ICONS;
    const json = await res.json();
    const favicon: string | null = json?.data?.favicon || null;
    if (!favicon) return DEFAULT_ICONS;
    return {
      icon: [{ url: favicon }],
      apple: [{ url: favicon, sizes: "180x180" }],
    };
  } catch {
    return DEFAULT_ICONS;
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const icons = await resolveIcons();
  return {
    metadataBase: new URL(SITE_URL),
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    icons,
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
  };
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