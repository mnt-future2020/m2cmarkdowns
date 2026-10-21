'use client';

import {
  Mail,
  Phone,
  MapPin,
  Clock,
  Send,
  Store,
  Loader2,
  Check,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import Reveal from '@/components/WebSite/Shared/Reveal';
import { showCenterNotice } from '@/components/UI/CenterNotice';
import { contactEnquiryService } from '@/services/contactEnquiryService';
import { companyInfoService, type PublicCompanyInfo } from '@/services/companyInfoService';
import { HEAR_ABOUT_US_OPTIONS } from '@/lib/enquirySources';
import Dropdown from '@/components/UI/Dropdown';
import VendorApplicationModal from '@/components/WebSite/Shared/VendorApplicationModal';

/**
 * The vendor band's ground - the pale rose panel from the homepage's Best
 * Seller row, copied string for string rather than matched by eye.
 *
 * It was `from-gray-900 to-gray-800`: #111827 to #1f2937, a cool blue-black
 * belonging to no palette on this site, meeting the maroon footer edge to
 * edge with nothing between them.
 *
 * Light maroon instead. Not a new colour - it is brand red pulled right down,
 * already carrying the homepage's Best Seller row and the DownloadApp QR
 * card. Kept identical to BestSeller.tsx so the two stay in step: if that one
 * is ever retuned, this is the same edit twice, not a fresh guess.
 *
 * Contrast on the darkest step (#f7e5e0), measured there and re-checked here:
 * body text #5f5550 is 5.94:1, the 11px eyebrow #c41617 is 4.96:1.
 */
const VENDOR_GROUND =
  'border-y border-[#eedad4] bg-linear-to-b from-[#fdf7f5] via-[#f7e5e0] to-[#fdf8f6]';
/**
 * One definition per control type. The fields used to carry their styling
 * inline, eight times over, which is how one of them ends up with a different
 * border than its neighbours after an edit.
 *
 * White fields on the panel's warm ground, rather than the old transparent
 * fields on grey - an input that is the same colour as the thing behind it
 * does not look like somewhere you can type.
 */
/**
 * Contact details are NOT hardcoded — they come from the admin company record
 * (companyInfoService.getPublicCompanyInfo(), the same source the footer uses),
 * built into the directory below at render time. Rows with no value are hidden,
 * so the page never shows a placeholder. "Customer Care · Available 24/7" is a
 * service statement (not company-specific data), so it stays as static copy.
 */

/**
 * One weight, one colour, for every value in the directory.
 *
 * The rows used to style themselves by whether the line happened to be
 * actionable: email and phone came out semibold near-black because they are
 * links, address and hours came out regular in a lighter grey because they are
 * not. Two properties changing at once, for a reason no reader could infer -
 * it just looked like two of the four rows had been missed.
 *
 * Being a link is now carried by behaviour instead: colour and an underline on
 * hover, and the pointer. Nothing that shifts the weight of static text.
 */
const DIRECTORY_LINE_CLASS = 'text-[14.5px] font-medium leading-relaxed text-[#1a1a1a]';

const LABEL_CLASS =
  'mb-2 block text-[13px] font-semibold text-[#3d352f] transition-colors duration-200 ' +
  // The wrapper is a `group`, so the caption picks up brand red the moment the
  // caret lands in its field. Pure CSS - no focus state to track in React.
  'group-focus-within:text-[#e01a1b]';
/**
 * The mark that fades into a field once it holds something usable.
 *
 * Scale as well as opacity: fading alone reads as a rendering glitch at this
 * size, where a thing that grows into place reads as a response.
 */
function FieldTick({ done, align = 'middle' }: { done: boolean; align?: 'middle' | 'top' }) {
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute right-3.5 grid h-6 w-6 place-items-center rounded-full bg-[#e6f5ec] text-[#1f9d57] transition-all duration-300 ${
        align === 'top' ? 'top-3.5' : 'top-1/2 -translate-y-1/2'
      } ${done ? 'scale-100 opacity-100' : 'scale-50 opacity-0'}`}
    >
      <Check className="h-3.5 w-3.5" strokeWidth={3} />
    </span>
  );
}

const FIELD_CLASS =
  'w-full rounded-xl border border-[#e6dcd0] bg-white px-4 py-3 text-[15px] text-[#1a1a1a] outline-none ' +
  'transition-colors placeholder:text-[#a89a8d] focus:border-[#e01a1b] focus:ring-2 focus:ring-[#e01a1b]/15';

/**
 * Tailwind v4 takes important as a SUFFIX (`bg-white!`), not the v3 prefix.
 * The shared Dropdown appends buttonClassName after its own defaults, but
 * source order in the stylesheet decides the winner, not order in the
 * attribute - so the two it already sets have to be forced.
 */
const DROPDOWN_BUTTON_CLASS = 'rounded-xl! border-[#e6dcd0]! px-4! py-3! text-[15px]!';
const Contact = () => {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    subject: '',
    message: '',
    hearAboutUs: '',
    hearAboutUsOther: ''
  });

  // The custom Dropdown is a button, not a form control, so native `required`
  // can't validate it — this drives the inline error instead.
  const [hearAboutUsError, setHearAboutUsError] = useState(false);
  const [hearAboutUsOtherError, setHearAboutUsOtherError] = useState(false);

  /**
   * The contact form had no in-flight state at all: the button stayed live
   * while the request was out, so a second click sent the same enquiry again.
   * The vendor form below has always guarded this; this one never did.
   */
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [showVendorModal, setShowVendorModal] = useState(false);

  // Live company contact details (same admin record the footer reads). Seed from
  // the cache for an instant first paint, then refresh from the API.
  const [info, setInfo] = useState<PublicCompanyInfo>(() => companyInfoService.getCachedCompanyInfo());
  useEffect(() => {
    let cancelled = false;
    companyInfoService.getPublicCompanyInfo().then((d) => { if (!cancelled) setInfo(d); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const email = info.companyEmail?.trim() || '';
  const phone = info.companyPhone?.trim() || '';
  const addressLines = useMemo(() => [
    info.registeredAddress?.trim(),
    [info.city, info.state, info.zipCode].map((v) => v?.trim()).filter(Boolean).join(', '),
    info.country?.trim(),
  ].filter(Boolean) as string[], [info]);

  // The directory, built from whatever contact details the admin has set. Rows
  // with no data are omitted so nothing ever shows a placeholder.
  const directory = useMemo(() => {
    const rows: { key: string; Icon: typeof Mail; label: string; lines: { text: string; href: string | null }[] }[] = [];
    if (email) rows.push({ key: 'email', Icon: Mail, label: 'Email Us', lines: [{ text: email, href: `mailto:${email}` }] });
    if (phone) rows.push({ key: 'phone', Icon: Phone, label: 'Call Us', lines: [{ text: phone, href: `tel:${phone.replace(/[^\d+]/g, '')}` }] });
    if (addressLines.length) rows.push({ key: 'address', Icon: MapPin, label: 'Visit Us', lines: addressLines.map((text) => ({ text, href: null })) });
    // Service statement (not company-specific data), always shown.
    rows.push({ key: 'support', Icon: Clock, label: 'Customer Care', lines: [{ text: 'Available 24/7', href: null }, { text: 'Every day of the week', href: null }] });
    return rows;
  }, [email, phone, addressLines]);

  /**
   * Which required answers are actually usable, recomputed on every keystroke.
   *
   * This drives the ticks and the meter at the head of the form, and it is a
   * separate question from whether the browser will let the form submit -
   * native validation only speaks up once you try. The point of showing it is
   * that a five-field form should tell you where you are while you are still
   * in it, rather than after you press the button.
   */
  const filled = useMemo(() => {
    // Deliberately loose. This decides whether to draw a tick, not whether to
    // accept the address - a stricter pattern here would tick "off" on
    // perfectly real addresses and read as the form arguing with you.
    const emailLooksReal = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email.trim());
    const sourceAnswered =
      formData.hearAboutUs !== '' &&
      (formData.hearAboutUs !== 'other' || formData.hearAboutUsOther.trim() !== '');

    return {
      name: formData.name.trim() !== '',
      email: emailLooksReal,
      subject: formData.subject.trim() !== '',
      source: sourceAnswered,
      message: formData.message.trim() !== '',
    };
  }, [formData]);

  const answeredCount = Object.values(filled).filter(Boolean).length;
  const requiredCount = Object.keys(filled).length;
  const readyToSend = answeredCount === requiredCount;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.hearAboutUs) {
      setHearAboutUsError(true);
      document.getElementById('hearAboutUs')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    // "Other" is only useful if they say what it was.
    if (formData.hearAboutUs === 'other' && !formData.hearAboutUsOther.trim()) {
      setHearAboutUsOtherError(true);
      document.getElementById('hearAboutUsOther')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setIsSubmitting(true);
    try {
      await contactEnquiryService.submitEnquiry({
        name: formData.name,
        email: formData.email,
        subject: formData.subject,
        message: formData.message,
        hearAboutUs: formData.hearAboutUs || undefined,
        hearAboutUsOther: formData.hearAboutUs === 'other' ? formData.hearAboutUsOther.trim() : undefined
      });

      // Reset form
      setFormData({ name: '', email: '', subject: '', message: '', hearAboutUs: '', hearAboutUsOther: '' });
      setHearAboutUsError(false);
      setHearAboutUsOtherError(false);
      // Centre-screen, not a corner toast. Sending the form is the end of the
      // task and the confirmation should land in front of you; the same popup
      // the vendor application uses, so the two read as one system. 4.5s rather
      // than the 2s default, because there are two lines to read.
      showCenterNotice(
        'success',
        'Thanks for contacting us!',
        'We’ve received your message and will get back to you soon.',
        4500,
      );
    } catch (error: unknown) {
      // Still logged in full; the customer just gets plain language rather than
      // whatever string the API happened to return.
      console.error('Contact form error:', error);
      showCenterNotice(
        'error',
        'Something went wrong',
        'We couldn’t send your message. Please try again.',
        4500,
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    });
  };


  return (
    <div className="bg-white font-sans" >
      {/* ── Customer care ────────────────────────────────────────────────
          This was a centred paragraph on a tint: an eyebrow reading "Get in
          touch" sitting directly above an h1 reading "Get in Touch", over copy
          inviting you to learn about our artisans, on a page for a discount
          home-textiles shop.

          For a while it carried a live Open now / Closed panel driven by a
          weekly schedule. That was the wrong idea for this business — M2C has
          no shopfront and support does not keep counter hours — so the panel,
          and every piece of clock machinery behind it (a fixed-timezone Intl
          formatter, a minute-aligned timer, a hydration-safe external store),
          came out. None of it is worth keeping for a company that is reachable
          all week.

          Centred rather than a two-column split, because with the panel gone
          there is no second column: text pinned left with nothing on the right
          is the stranded-object problem this page already had once. */}
      <section className="border-b border-[#efe4d8] bg-[#faf7f3] py-12 font-sans sm:py-14 lg:py-16">
        <div className="mx-auto max-w-7xl px-3 sm:px-4 md:px-6 lg:px-8">
          <Reveal className="mx-auto max-w-3xl text-center">
            <span className="mb-3 inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#e01a1b] sm:text-xs">
              <span aria-hidden className="h-px w-6 bg-[#e01a1b]" />
              Customer care
            </span>

            <h1 className="mb-3 font-playfair text-3xl font-semibold tracking-tight text-[#1a1a1a] sm:text-4xl lg:text-5xl">
              We&apos;re here to help
            </h1>

            <p className="mx-auto max-w-2xl text-base leading-relaxed text-[#5f5550] sm:text-lg">
              Questions about an order, a return, or when something will arrive
              &mdash; reach us whichever way suits you.
            </p>

            {/* The primary phone + email, pulled from the admin company record;
                each chip renders only when that detail is set. */}
            <div className="mt-7 flex flex-wrap justify-center gap-2.5">
              {phone && (
              <a
                href={`tel:${phone.replace(/[^\d+]/g, '')}`}
                className="inline-flex max-w-full items-center gap-2 rounded-full border border-[#e6dcd0] bg-white px-4 py-2.5 text-sm font-semibold text-[#1a1a1a] transition-colors hover:border-[#e01a1b] hover:text-[#e01a1b]"
              >
                <Phone aria-hidden className="h-4 w-4 shrink-0 text-[#e01a1b]" />
                <span className="truncate">{phone}</span>
              </a>
              )}
              {email && (
              <a
                href={`mailto:${email}`}
                className="inline-flex max-w-full items-center gap-2 rounded-full border border-[#e6dcd0] bg-white px-4 py-2.5 text-sm font-semibold text-[#1a1a1a] transition-colors hover:border-[#e01a1b] hover:text-[#e01a1b]"
              >
                <Mail aria-hidden className="h-4 w-4 shrink-0 text-[#e01a1b]" />
                <span className="truncate">{email}</span>
              </a>
              )}
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── Contact information, and the message form ──────────────────
          Every word and every value in here is the copy the page already
          carried, placeholder emails and +1 (555) numbers included. Those are
          the owner's to change, not a UI pass's.

          What changed is that the section responds now. It used to be two
          still panels: you read the left one, you filled the right one, and
          nothing on screen acknowledged either. A five-field form should tell
          you where you are while you are still inside it, not after you press
          the button — so the head of the form keeps a running count, each
          field marks itself once it holds something usable, and the caption
          above whichever field has the caret turns brand red. The directory
          answers to the pointer the same way. */}
      <section className="bg-white py-12 font-sans sm:py-14 lg:py-16">
        <div className="mx-auto max-w-7xl px-3 sm:px-4 md:px-6 lg:px-8">
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-12 lg:gap-12">
            <div className="lg:col-span-5">
              <Reveal>
                <span className="mb-3 inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#e01a1b] sm:text-xs">
                  <span aria-hidden className="h-px w-6 bg-[#e01a1b]" />
                  Reach Us
                </span>
                <h2 className="mb-5 font-playfair text-2xl font-semibold tracking-tight text-[#1a1a1a] sm:text-3xl">
                  Contact Information
                </h2>
              </Reveal>

              <div className="divide-y divide-[#f2e9df] overflow-hidden rounded-2xl border border-[#efe4d8] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                {directory.map((row, index) => (
                  <Reveal
                    key={row.key}
                    delay={index * 80}
                    className="group relative flex items-start gap-4 overflow-hidden px-5 py-4 transition-colors duration-300 hover:bg-[#faf7f3]"
                  >
                    {/* Wipes down from the top rather than fading in — a bar
                        that draws itself reads as the row answering, where one
                        that simply appears reads as a repaint. */}
                    <span
                      aria-hidden
                      className="absolute left-0 top-0 h-full w-[3px] origin-top scale-y-0 bg-[#e01a1b] transition-transform duration-300 ease-out group-hover:scale-y-100"
                    />

                    <span
                      aria-hidden
                      className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[#fdf3f0] text-[#e01a1b] transition-all duration-300 group-hover:scale-110 group-hover:bg-[#e01a1b] group-hover:text-white"
                    >
                      <row.Icon className="h-5 w-5" />
                    </span>

                    <div className="min-w-0 flex-1 transition-transform duration-300 group-hover:translate-x-1">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#a89a8d]">
                        {row.label}
                      </p>
                      <div className="mt-1 space-y-0.5">
                        {row.lines.map((line) =>
                          line.href ? (
                            <a
                              key={line.text}
                              href={line.href}
                              className={`${DIRECTORY_LINE_CLASS} block truncate transition-colors hover:text-[#e01a1b] hover:underline hover:underline-offset-4`}
                            >
                              {line.text}
                            </a>
                          ) : (
                            <p key={line.text} className={DIRECTORY_LINE_CLASS}>
                              {line.text}
                            </p>
                          ),
                        )}
                      </div>
                    </div>
                  </Reveal>
                ))}
              </div>

              <Reveal
                delay={320}
                className="mt-6 rounded-2xl border border-[#efe4d8] bg-[#faf7f3] p-5 sm:p-6"
              >
                <h3 className="text-lg font-semibold text-[#1a1a1a]">For Artisan Partnerships</h3>
                <p className="mt-2 text-[14.5px] leading-relaxed text-[#5f5550]">
                  Are you a skilled artisan interested in joining our marketplace? We&apos;d love to
                  learn about your craft and explore partnership opportunities.
                </p>
                {email && (
                  <p className="mt-3 text-[14.5px] text-[#5f5550]">
                    Email us at:{' '}
                    <a
                      href={`mailto:${email}`}
                      className="font-semibold text-[#e01a1b] transition-colors hover:text-[#c41617]"
                    >
                      {email}
                    </a>
                  </p>
                )}
              </Reveal>
            </div>

            <div className="lg:col-span-7">
              <Reveal>
                <span className="mb-3 inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#e01a1b] sm:text-xs">
                  <span aria-hidden className="h-px w-6 bg-[#e01a1b]" />
                  Say Hello
                </span>
                <h2 className="mb-5 font-playfair text-2xl font-semibold tracking-tight text-[#1a1a1a] sm:text-3xl">
                  Send us a Message
                </h2>
              </Reveal>

              {/* Deliberately NOT inside <Reveal>. `.reveal` sets
                  `will-change: transform`, which opens a stacking context that
                  never closes — and the shared Dropdown positions its list with
                  `absolute z-50`, so inside a Reveal the options open behind
                  whatever follows on the page. */}
              <form
                onSubmit={handleSubmit}
                className="rounded-2xl border border-[#efe4d8] bg-[#faf7f3] p-5 sm:p-7"
              >
                {/* The meter. It turns green on completion rather than staying
                    brand red: the colour change is the moment worth marking,
                    and it is catchable from the corner of the eye while you are
                    still looking at the last field. */}
                <div className="mb-6">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#a89a8d]">
                      Your message
                    </span>
                    <span
                      className={`inline-flex items-center gap-1.5 text-[12.5px] font-semibold tabular-nums transition-colors duration-300 ${
                        readyToSend ? 'text-[#1f9d57]' : 'text-[#7a6d62]'
                      }`}
                    >
                      {readyToSend && <Check aria-hidden className="h-3.5 w-3.5" strokeWidth={3} />}
                      {readyToSend ? 'Ready to send' : `${answeredCount} of ${requiredCount} complete`}
                    </span>
                  </div>
                  <div
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={requiredCount}
                    aria-valuenow={answeredCount}
                    aria-label="Required fields completed"
                    className="h-1 overflow-hidden rounded-full bg-[#eee3d7]"
                  >
                    <div
                      className={`h-full rounded-full transition-all duration-500 ease-out ${
                        readyToSend ? 'bg-[#1f9d57]' : 'bg-[#e01a1b]'
                      }`}
                      style={{ width: `${(answeredCount / requiredCount) * 100}%` }}
                    />
                  </div>
                </div>

                {/* Name and email pair up: two short fields that used to eat
                    two full rows of a very tall form. */}
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                  <div className="group">
                    <label htmlFor="name" className={LABEL_CLASS}>
                      Full Name *
                    </label>
                    <div className="relative">
                      <input
                        type="text"
                        id="name"
                        name="name"
                        required
                        value={formData.name}
                        onChange={handleChange}
                        className={`${FIELD_CLASS} pr-11`}
                        placeholder="Your full name"
                      />
                      <FieldTick done={filled.name} />
                    </div>
                  </div>

                  <div className="group">
                    <label htmlFor="email" className={LABEL_CLASS}>
                      Email Address *
                    </label>
                    <div className="relative">
                      <input
                        type="email"
                        id="email"
                        name="email"
                        required
                        value={formData.email}
                        onChange={handleChange}
                        className={`${FIELD_CLASS} pr-11`}
                        placeholder="your.email@example.com"
                      />
                      <FieldTick done={filled.email} />
                    </div>
                  </div>
                </div>

                <div className="group mt-5">
                  <label htmlFor="subject" className={LABEL_CLASS}>
                    Subject *
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      id="subject"
                      name="subject"
                      required
                      value={formData.subject}
                      onChange={handleChange}
                      className={`${FIELD_CLASS} pr-11`}
                      placeholder="What is this regarding?"
                    />
                    <FieldTick done={filled.subject} />
                  </div>
                </div>

                <div className="group mt-5">
                  <label htmlFor="hearAboutUs" className={LABEL_CLASS}>
                    How Did You Hear About Us? *
                  </label>
                  {/* Shared Dropdown (same control as checkout / admin) — a
                      native <select> renders the OS menu, which ignores the
                      brand theme. It is a button, not a form control, so native
                      `required` cannot validate it; the inline error does.

                      No tick on this one: the panel's own chevron already owns
                      the right-hand end of the control, and the chosen answer
                      is written across the face of it. */}
                  <Dropdown
                    id="hearAboutUs"
                    value={formData.hearAboutUs}
                    options={HEAR_ABOUT_US_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                    placeholder="Please select an option"
                    onChange={(val) => {
                      const next = val as string;
                      setFormData((prev) => ({
                        ...prev,
                        hearAboutUs: next,
                        // Drop any stale text when switching away from "Other".
                        hearAboutUsOther: next === 'other' ? prev.hearAboutUsOther : '',
                      }));
                      setHearAboutUsError(false);
                      setHearAboutUsOtherError(false);
                    }}
                    error={hearAboutUsError}
                    buttonClassName={DROPDOWN_BUTTON_CLASS}
                  />
                  {hearAboutUsError && (
                    <p className="mt-1.5 text-sm text-[#e01a1b]">Please select an option.</p>
                  )}

                  {/* "Other" needs the actual answer, otherwise the bucket is
                      meaningless in the source report. */}
                  {formData.hearAboutUs === 'other' && (
                    <div className="mt-4">
                      <label htmlFor="hearAboutUsOther" className={LABEL_CLASS}>
                        Please tell us how *
                      </label>
                      <div className="relative">
                        <input
                          type="text"
                          id="hearAboutUsOther"
                          name="hearAboutUsOther"
                          maxLength={200}
                          value={formData.hearAboutUsOther}
                          onChange={(e) => {
                            handleChange(e);
                            if (e.target.value.trim()) setHearAboutUsOtherError(false);
                          }}
                          className={`${FIELD_CLASS} pr-11 ${
                            hearAboutUsOtherError ? 'border-[#e01a1b]! bg-red-50/40!' : ''
                          }`}
                          placeholder="e.g. Saw your stall at a local market"
                        />
                        <FieldTick done={formData.hearAboutUsOther.trim() !== ''} />
                      </div>
                      {hearAboutUsOtherError && (
                        <p className="mt-1.5 text-sm text-[#e01a1b]">
                          Please tell us how you heard about us.
                        </p>
                      )}
                    </div>
                  )}
                </div>

                <div className="group mt-5">
                  <label htmlFor="message" className={LABEL_CLASS}>
                    Message *
                  </label>
                  <div className="relative">
                    <textarea
                      id="message"
                      name="message"
                      required
                      rows={5}
                      value={formData.message}
                      onChange={handleChange}
                      className={`${FIELD_CLASS} resize-y pr-11`}
                      placeholder="Tell us more about your inquiry..."
                    />
                    <FieldTick done={filled.message} align="top" />
                  </div>
                  {/* Always rendered, only sometimes visible, so the button
                      below does not jump the first time you type. */}
                  <div className="mt-1.5 flex justify-end">
                    <span
                      className={`text-[12px] tabular-nums text-[#a89a8d] transition-opacity duration-300 ${
                        formData.message.length ? 'opacity-100' : 'opacity-0'
                      }`}
                    >
                      {formData.message.length} characters
                    </span>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className={`btn-shine mt-5 flex w-full items-center justify-center gap-2 rounded-full bg-[#e01a1b] px-6 py-3.5 font-semibold text-white shadow-[0_6px_20px_rgba(224,26,27,0.3)] transition-all duration-300 hover:-translate-y-0.5 hover:bg-[#c41617] hover:shadow-[0_12px_30px_rgba(224,26,27,0.45)] disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0 sm:w-auto sm:px-10 ${
                    readyToSend ? 'ring-4 ring-[#e01a1b]/15' : ''
                  }`}
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 aria-hidden className="h-5 w-5 animate-spin" />
                      Sending...
                    </>
                  ) : (
                    <>
                      <Send aria-hidden className="h-5 w-5" />
                      Send Message
                    </>
                  )}
                </button>
              </form>
            </div>
          </div>
        </div>
      </section>

      {/* Vendor Invitation Section */}
      <section className={`py-10 sm:py-12 lg:py-16 ${VENDOR_GROUND}`}>
        <div className="max-w-7xl mx-auto px-3 sm:px-4 md:px-6 lg:px-8">
          <Reveal className="text-center">
            {/* `flex` and not `inline-flex`.
                Both this and the eyebrow below it were inline-level inside a
                text-center block, so they shared a line and the eyebrow hung
                off the disc's right shoulder - and the disc's own mb-6 did
                nothing, because there was no line break for it to act across.
                A block-level box pushes the eyebrow onto its own line, which is
                what the margin was always written for. */}
            <div className="mx-auto flex items-center justify-center w-12 h-12 sm:w-16 sm:h-16 bg-[#e01a1b] rounded-full mb-4 sm:mb-6 shadow-[0_6px_20px_rgba(224,26,27,0.4)]">
              <Store className="w-6 h-6 sm:w-8 sm:h-8 text-white" />
            </div>
            {/* The deep brand red the Best Seller row uses for the same
                eyebrow, not the #f24344 this carried on the navy - that tone
                was picked to survive a dark ground and is far too pale to hold
                on a light one. */}
            <span className="inline-flex items-center gap-2 text-[11px] sm:text-xs font-semibold uppercase tracking-[0.18em] text-[#c41617] mb-3">
              <span aria-hidden className="h-px w-6 bg-[#c41617]" />
              Partner With Us
            </span>
            <h2 className="font-playfair text-2xl sm:text-3xl lg:text-4xl font-semibold text-[#1a1a1a] tracking-tight mb-3 sm:mb-4">
              Become a Vendor Partner
            </h2>
            <p className="text-base sm:text-lg lg:text-xl text-[#5f5550] max-w-3xl mx-auto mb-6 sm:mb-8">
              Join our marketplace and showcase your products to thousands of customers.
              We're looking for quality vendors who share our commitment to excellence.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-5 lg:gap-6 max-w-4xl mx-auto mb-8 sm:mb-10">
              <div className="bg-white p-4 sm:p-5 lg:p-6 rounded-2xl ring-1 ring-[#eedad4] shadow-[0_1px_2px_rgba(0,0,0,0.04)] hover:ring-[#e01a1b]/35 hover:shadow-[0_14px_32px_-18px_rgba(196,22,23,0.45)] hover:-translate-y-0.5 transition-all duration-500">
                <div className="text-2xl sm:text-3xl font-bold text-[#1a1a1a] mb-1 sm:mb-2">10K+</div>
                <div className="text-sm sm:text-base text-[#5f5550]">Active Customers</div>
              </div>
              <div className="bg-white p-4 sm:p-5 lg:p-6 rounded-2xl ring-1 ring-[#eedad4] shadow-[0_1px_2px_rgba(0,0,0,0.04)] hover:ring-[#e01a1b]/35 hover:shadow-[0_14px_32px_-18px_rgba(196,22,23,0.45)] hover:-translate-y-0.5 transition-all duration-500">
                <div className="text-2xl sm:text-3xl font-bold text-[#1a1a1a] mb-1 sm:mb-2">500+</div>
                <div className="text-sm sm:text-base text-[#5f5550]">Vendor Partners</div>
              </div>
              {/* Briefly read "2-3 Days · Application Review", swapped in
                  because the live hours panel at the top of this page
                  contradicted a 24/7 claim. Confirmed since that support
                  genuinely is round the clock, and the panel has gone, so this
                  is back to the copy the page always carried. */}
              <div className="bg-white p-4 sm:p-5 lg:p-6 rounded-2xl ring-1 ring-[#eedad4] shadow-[0_1px_2px_rgba(0,0,0,0.04)] hover:ring-[#e01a1b]/35 hover:shadow-[0_14px_32px_-18px_rgba(196,22,23,0.45)] hover:-translate-y-0.5 transition-all duration-500">
                <div className="text-2xl sm:text-3xl font-bold text-[#1a1a1a] mb-1 sm:mb-2">24/7</div>
                <div className="text-sm sm:text-base text-[#5f5550]">Support Available</div>
              </div>
            </div>

            <button
              onClick={() => setShowVendorModal(true)}
              className="btn-shine bg-[#e01a1b] text-white px-6 sm:px-8 py-3 sm:py-4 rounded-full font-semibold text-base sm:text-lg hover:bg-[#c41617] transition-all duration-300 transform hover:-translate-y-0.5 shadow-[0_6px_20px_rgba(224,26,27,0.35)] hover:shadow-[0_12px_30px_rgba(224,26,27,0.5)] inline-flex items-center gap-2"
            >
              <Store className="w-5 h-5" />
              Join Us as a Vendor
            </button>
          </Reveal>
        </div>
      </section>

      {/* One shared component, not a second copy of the same form.
          This page carried its own inline version of the vendor application
          while the header's SELL ON M2C button and the home page's promo
          banner already rendered a shared one - two implementations of one
          form, free to drift apart, and only one of them ever getting fixed.
          Same fields, same service call, same toasts. */}
      <VendorApplicationModal open={showVendorModal} onClose={() => setShowVendorModal(false)} />
    </div>
  );
};

export default Contact;
