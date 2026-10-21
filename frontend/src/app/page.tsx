'use client'

import Header from '@/components/WebSite/Header/Header';
import Footer from '@/components/WebSite/Footer/Footer';
import HeroSection from '@/components/WebSite/HeroSection/HeroSection';
import PromoStrip from '@/components/WebSite/PromoStrip/PromoStrip';
import NoticeBoard from '@/components/WebSite/NoticeBoard/NoticeBoard';
import Category from '@/components/WebSite/Category/Category';
import FeaturedProducts from '@/components/WebSite/Featured/Products';
import TopSelling from '@/components/WebSite/Featured/TopSelling';
import BestSeller from '@/components/WebSite/Featured/BestSeller';
import BrandPromo from '@/components/WebSite/BrandPromo/BrandPromo';
import DownloadApp from '@/components/WebSite/DownloadApp/DownloadApp';
import ValueSection from '@/components/WebSite/Footer/ValueSection';
import SEOHead from '@/components/SEO/SEOHead';

export default function Home() {
  return (
    <div className="min-h-screen bg-gray-50">
      <SEOHead
        pageName="home"
        defaultTitle="M2C Marketplace - Your B2B Partner"
        defaultDescription="Discover quality products and reliable suppliers on M2C Marketplace"
      />
      <Header />
      <HeroSection />
      <PromoStrip />
      <NoticeBoard />
      <FeaturedProducts />
      <BrandPromo />
      <TopSelling />
      <BestSeller />
      <Category />
      <DownloadApp />
      <ValueSection />
      <Footer />
    </div>
  );
}
