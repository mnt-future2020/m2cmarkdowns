import React, { useState, useEffect, useRef } from 'react';
import { Save, Upload, X, Image, Trash2, GripVertical, Plus, Eye, EyeOff, Info, Link2, Edit, ChevronDown } from 'lucide-react';
import { Card, CardContent } from '../../UI/Card';
import Dropdown from '../../UI/Dropdown';
import { showSuccessToast, showErrorToast } from '@/lib/toast-utils';
import { bannerService, BannerImage, BannerLink, BANNER_LINK_ALL } from '@/services/bannerService';
import { categoryService } from '@/services/categoryService';
import { adminProductService } from '@/services/adminProductService';
import { hasPermission } from '@/lib/auth';
import BannerCropModal from './BannerCropModal';
import DeleteConfirmModal from '@/components/UI/DeleteConfirmModal';

// Banner display spec — must match the homepage hero's frame ratio so the crop
// the admin sees is exactly what the storefront shows (WYSIWYG). The hero frame
// is held at 3 : 1 (BANNER_RATIO in HeroSection.tsx, a single ratio across every
// breakpoint); cropping uploads to that same ratio means object-cover never
// re-crops the image on the storefront. If HeroSection's BANNER_RATIO changes,
// change these to match.
const REC_WIDTH = 2400;
const REC_HEIGHT = 800;
const TARGET_RATIO = REC_WIDTH / REC_HEIGHT; // 3 : 1 — matches HeroSection BANNER_RATIO

// Link-type options for the "Link to" dropdown.
const LINK_TYPE_OPTIONS = [
    { value: 'none', label: 'No link' },
    { value: 'product', label: 'Product' },
    { value: 'category', label: 'Category' },
];

type BLOption = { value: string; name: string; sku?: string; category?: string };

// A button that opens a dropdown panel and closes on outside-click.
function MiniDropdown({
    open, setOpen, label, children,
}: {
    open: boolean; setOpen: (v: boolean) => void; label: React.ReactNode; children: React.ReactNode;
}) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [open, setOpen]);
    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                onClick={() => setOpen(!open)}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 border border-slate-300 rounded-lg bg-white text-sm text-left hover:border-slate-400 transition-colors"
            >
                <span className="truncate">{label}</span>
                <ChevronDown className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
            {open && (
                <div className="absolute z-30 mt-1 w-full min-w-[16rem] bg-white border border-slate-200 rounded-lg shadow-lg">
                    {children}
                </div>
            )}
        </div>
    );
}

/**
 * Banner "Link to" selector — multi-select.
 *   • Category → pick one or many categories (or "All categories"). Clicking the
 *     banner opens /products filtered to those categories.
 *   • Product  → first narrow by category, then pick one or many products (or "All
 *     products"). Clicking opens /products filtered to those products.
 * The selection is stored comma-joined in `value` (or the BANNER_LINK_ALL sentinel).
 */
function BannerLinkSelector({
    type, setType, value, setValue, categories, products,
}: {
    type: 'none' | 'product' | 'category';
    setType: (t: 'none' | 'product' | 'category') => void;
    value: string;
    setValue: (v: string) => void;
    categories: BLOption[];
    products: BLOption[];
}) {
    const isAll = value === BANNER_LINK_ALL;
    const selected = !isAll && value ? value.split(',').map((s) => s.trim()).filter(Boolean) : [];

    const [openTarget, setOpenTarget] = useState(false);
    const [q, setQ] = useState('');
    // Product mode: filter the product list by category first (UI only, not stored).
    const [openCat, setOpenCat] = useState(false);
    const [catQ, setCatQ] = useState('');
    const [prodCatFilter, setProdCatFilter] = useState<string[]>([]); // category NAMES

    const setSlugs = (ids: string[]) => setValue(ids.join(','));
    const toggle = (slug: string) => {
        const base = isAll ? [] : selected;
        setSlugs(base.includes(slug) ? base.filter((x) => x !== slug) : [...base, slug]);
    };

    const s = q.trim().toLowerCase();
    const filteredCats = categories.filter((c) => c.name.toLowerCase().includes(s));
    const filteredProds = products.filter((p) =>
        (prodCatFilter.length === 0 || (p.category && prodCatFilter.includes(p.category))) &&
        (!s || p.name.toLowerCase().includes(s) || String(p.sku || '').toLowerCase().includes(s)),
    );

    const targetLabel = () => {
        if (type === 'none') return null;
        if (isAll) return type === 'product' ? 'All products' : 'All categories';
        if (selected.length === 0) return <span className="text-slate-400">{type === 'product' ? 'Select products…' : 'Select categories…'}</span>;
        if (selected.length === 1) {
            const opt = (type === 'product' ? products : categories).find((o) => o.value === selected[0]);
            return opt?.name || `1 ${type}`;
        }
        return `${selected.length} ${type === 'product' ? 'products' : 'categories'} selected`;
    };

    return (
        <div>
            <label className="flex items-center gap-1.5 text-sm font-medium text-slate-700 mb-1.5">
                <Link2 className="h-4 w-4 text-slate-400" /> Link to (optional)
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div>
                    <Dropdown
                        value={type}
                        options={LINK_TYPE_OPTIONS}
                        onChange={(v) => { setType(v as 'none' | 'product' | 'category'); setValue(''); setProdCatFilter([]); setQ(''); }}
                        buttonClassName="py-2 rounded-lg text-sm"
                    />
                </div>

                {/* Product mode: category filter (narrows the product list). */}
                {type === 'product' && (
                    <MiniDropdown
                        open={openCat}
                        setOpen={(v) => { setOpenCat(v); setCatQ(''); }}
                        label={<span className={prodCatFilter.length ? 'text-slate-800' : 'text-slate-400'}>
                            {prodCatFilter.length ? `${prodCatFilter.length} categor${prodCatFilter.length === 1 ? 'y' : 'ies'}` : 'Filter by category'}
                        </span>}
                    >
                        <div className="p-2 border-b border-slate-100">
                            <input value={catQ} onChange={(e) => setCatQ(e.target.value)} placeholder="Search categories…" autoFocus
                                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg outline-none focus:border-[#e01a1b]" />
                        </div>
                        <div className="max-h-52 overflow-y-auto">
                            {categories.filter((c) => c.name.toLowerCase().includes(catQ.trim().toLowerCase())).map((c) => {
                                const on = prodCatFilter.includes(c.name);
                                return (
                                    <label key={c.value} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50 cursor-pointer">
                                        <input type="checkbox" className="w-4 h-4 rounded accent-[#e01a1b]" checked={on}
                                            onChange={() => setProdCatFilter(on ? prodCatFilter.filter((x) => x !== c.name) : [...prodCatFilter, c.name])} />
                                        <span className="text-slate-700">{c.name}</span>
                                    </label>
                                );
                            })}
                            {categories.length === 0 && <p className="px-3 py-2 text-xs text-slate-400">No categories</p>}
                        </div>
                    </MiniDropdown>
                )}

                {/* Target multi-select (categories or products). */}
                {type !== 'none' && (
                    <div className={type === 'product' ? '' : 'sm:col-span-2'}>
                        <MiniDropdown open={openTarget} setOpen={(v) => { setOpenTarget(v); setQ(''); }} label={targetLabel()}>
                            <div className="p-2 border-b border-slate-100">
                                <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus
                                    placeholder={type === 'product' ? 'Search by name or SKU…' : 'Search by name…'}
                                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg outline-none focus:border-[#e01a1b]" />
                            </div>
                            {/* All … row (exclusive). */}
                            <label className="flex items-center gap-2 px-3 py-2 text-sm border-b border-slate-100 bg-slate-50/70 hover:bg-slate-100 cursor-pointer">
                                <input type="checkbox" className="w-4 h-4 rounded accent-[#e01a1b]" checked={isAll}
                                    onChange={() => setValue(isAll ? '' : BANNER_LINK_ALL)} />
                                <span className="font-semibold text-slate-700">{type === 'product' ? 'All products' : 'All categories'}</span>
                            </label>
                            <div className="max-h-52 overflow-y-auto">
                                {type === 'category'
                                    ? filteredCats.map((c) => {
                                        const on = !isAll && selected.includes(c.value);
                                        return (
                                            <label key={c.value} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50 cursor-pointer">
                                                <input type="checkbox" className="w-4 h-4 rounded accent-[#e01a1b]" checked={on} onChange={() => toggle(c.value)} />
                                                <span className="text-slate-700">{c.name}</span>
                                            </label>
                                        );
                                    })
                                    : filteredProds.map((p) => {
                                        const on = !isAll && selected.includes(p.value);
                                        return (
                                            <label key={p.value} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50 cursor-pointer">
                                                <input type="checkbox" className="w-4 h-4 rounded accent-[#e01a1b] shrink-0" checked={on} onChange={() => toggle(p.value)} />
                                                <span className="min-w-0">
                                                    <span className="block truncate text-slate-800">{p.name}</span>
                                                    {p.sku && <span className="block truncate text-[11px] font-mono text-slate-400">SKU: {p.sku}</span>}
                                                </span>
                                                {p.category && <span className="ml-auto text-xs text-slate-400 shrink-0">{p.category}</span>}
                                            </label>
                                        );
                                    })}
                                {(type === 'category' ? filteredCats.length : filteredProds.length) === 0 && (
                                    <p className="px-3 py-2 text-xs text-slate-400">No {type === 'product' ? 'products' : 'categories'} found</p>
                                )}
                            </div>
                        </MiniDropdown>
                    </div>
                )}
            </div>
            <p className="text-xs text-slate-500 mt-1">
                {type === 'none'
                    ? 'This banner is not clickable.'
                    : `Clicking opens the ${type === 'product' ? 'selected products' : 'selected categories'} on the storefront. Leave the target empty to keep it non-clickable.`}
            </p>
        </div>
    );
}

export default function BannerSettingsTab() {
    const canManage = hasPermission('settings:edit');
    const [loading, setLoading] = useState(false);
    const [initialLoading, setInitialLoading] = useState(true);
    const [banners, setBanners] = useState<BannerImage[]>([]);
    const [uploading, setUploading] = useState(false);
    const [newAltText, setNewAltText] = useState('');
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [filePreview, setFilePreview] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editAltText, setEditAltText] = useState('');
    const [editFile, setEditFile] = useState<File | null>(null);
    const [editFilePreview, setEditFilePreview] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    // Banner queued for deletion — drives the confirmation modal. Null when closed.
    const [pendingDelete, setPendingDelete] = useState<{ id: string; order: number } | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const editFileInputRef = useRef<HTMLInputElement>(null);
    // Image awaiting a crop-to-ratio pass before it becomes the selected banner.
    const [cropState, setCropState] = useState<{ src: string; fileName: string; target: 'new' | 'edit' } | null>(null);

    // Click-through link options (loaded once) + the current form selections.
    // linkValue holds the target's slug (product route accepts slug or id).
    const [linkProducts, setLinkProducts] = useState<{ value: string; name: string; sku?: string; category?: string }[]>([]);
    const [linkCategories, setLinkCategories] = useState<{ value: string; name: string }[]>([]);
    const [newLinkType, setNewLinkType] = useState<'none' | 'product' | 'category'>('none');
    const [newLinkValue, setNewLinkValue] = useState('');
    const [editLinkType, setEditLinkType] = useState<'none' | 'product' | 'category'>('none');
    const [editLinkValue, setEditLinkValue] = useState('');

    // Human label for a chosen link value (handles the "All …" sentinel, a single
    // item, or a comma-joined set → "N products" / "N categories").
    const linkLabelFor = (type: 'product' | 'category', value: string): string | undefined => {
        if (value === BANNER_LINK_ALL) return type === 'product' ? 'All products' : 'All categories';
        const src = type === 'product' ? linkProducts : linkCategories;
        const slugs = value.split(',').map((s) => s.trim()).filter(Boolean);
        const names = slugs.map((s) => src.find((o) => o.value === s)?.name).filter(Boolean) as string[];
        if (names.length === 0) return undefined;
        if (names.length === 1) return names[0];
        return `${names.length} ${type === 'product' ? 'products' : 'categories'}`;
    };

    // Turn the form selections into the payload the service expects (+ cache the label).
    const buildLink = (type: 'none' | 'product' | 'category', value: string): BannerLink => {
        if (type === 'none' || !value) return { linkType: 'none' };
        return { linkType: type, linkValue: value, linkLabel: linkLabelFor(type, value) };
    };

    useEffect(() => {
        fetchBanners();
        fetchLinkOptions();
    }, []);

    // Load products + categories once to populate the "link to" dropdowns.
    const fetchLinkOptions = async () => {
        try {
            const [catRes, prodRes] = await Promise.all([
                categoryService.getCategories({ status: 'ACTIVE', showRootOnly: true }),
                adminProductService.getAllProducts({ status: 'ACTIVE', limit: 500 }),
            ]);
            setLinkCategories(
                (catRes.data || []).map((c: any) => ({ value: c.slug, name: c.name })).filter((o: any) => o.value)
            );
            setLinkProducts(
                (prodRes.data?.products || []).map((p: any) => ({ value: p.slug || p.id, name: p.name, sku: p.baseSku, category: p.category }))
            );
        } catch (error) {
            // Non-fatal: the link dropdowns just stay empty.
            console.error('Failed to load banner link options:', error);
        }
    };

    const fetchBanners = async () => {
        try {
            setInitialLoading(true);
            const response = await bannerService.getAllBanners();
            if (response.success && Array.isArray(response.data)) {
                setBanners(response.data);
            }
        } catch (error) {
            showErrorToast('Error', 'Failed to fetch banners');
        } finally {
            setInitialLoading(false);
        }
    };

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        if (!file.type.startsWith('image/')) {
            showErrorToast('Invalid File', 'Please select an image file');
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            showErrorToast('File Too Large', 'Image size should be less than 5MB');
            return;
        }

        // Open the cropper first so the saved image always matches the banner ratio.
        const reader = new FileReader();
        reader.onload = (e) => {
            const dataUrl = e.target?.result as string;
            setCropState({ src: dataUrl, fileName: file.name, target: 'new' });
        };
        reader.readAsDataURL(file);
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const handleEditFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        if (!file.type.startsWith('image/')) {
            showErrorToast('Invalid File', 'Please select an image file');
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            showErrorToast('File Too Large', 'Image size should be less than 5MB');
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            const dataUrl = e.target?.result as string;
            setCropState({ src: dataUrl, fileName: file.name, target: 'edit' });
        };
        reader.readAsDataURL(file);
        if (editFileInputRef.current) editFileInputRef.current.value = '';
    };

    // Cropped result → becomes the selected (new) or replacement (edit) banner image.
    const handleCropped = (file: File, dataUrl: string) => {
        if (cropState?.target === 'edit') {
            setEditFile(file);
            setEditFilePreview(dataUrl);
        } else {
            setSelectedFile(file);
            setFilePreview(dataUrl);
        }
        setCropState(null);
    };

    const clearNewForm = () => {
        setSelectedFile(null);
        setFilePreview(null);
        setNewAltText('');
        setNewLinkType('none');
        setNewLinkValue('');
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const handleAddBanner = async () => {
        if (!selectedFile) {
            showErrorToast('Error', 'Please select an image');
            return;
        }

        try {
            setUploading(true);
            const response = await bannerService.addBanner(selectedFile, newAltText, buildLink(newLinkType, newLinkValue));
            if (response.success) {
                showSuccessToast('Success', 'Banner added successfully');
                clearNewForm();
                fetchBanners();
            }
        } catch (error) {
            showErrorToast('Error', 'Failed to add banner');
        } finally {
            setUploading(false);
        }
    };

    const handleToggleActive = async (banner: BannerImage) => {
        try {
            const response = await bannerService.updateBanner(banner.id, { isActive: !banner.isActive });
            if (response.success) {
                showSuccessToast('Success', `Banner ${banner.isActive ? 'hidden' : 'shown'} successfully`);
                fetchBanners();
            }
        } catch (error) {
            showErrorToast('Error', 'Failed to update banner');
        }
    };

    const startEditing = (banner: BannerImage) => {
        setEditingId(banner.id);
        setEditAltText(banner.altText || '');
        setEditFile(null);
        setEditFilePreview(null);
        setEditLinkType((banner.linkType as 'product' | 'category') || 'none');
        setEditLinkValue(banner.linkValue || '');
    };

    const cancelEditing = () => {
        setEditingId(null);
        setEditAltText('');
        setEditFile(null);
        setEditFilePreview(null);
        setEditLinkType('none');
        setEditLinkValue('');
        if (editFileInputRef.current) editFileInputRef.current.value = '';
    };

    const handleUpdateBanner = async (id: string) => {
        try {
            setLoading(true);
            const response = await bannerService.updateBanner(id, { altText: editAltText }, editFile || undefined, buildLink(editLinkType, editLinkValue));
            if (response.success) {
                showSuccessToast('Success', 'Banner updated successfully');
                cancelEditing();
                fetchBanners();
            }
        } catch (error) {
            showErrorToast('Error', 'Failed to update banner');
        } finally {
            setLoading(false);
        }
    };

    // The trash icon only opens the confirmation modal; the actual delete runs from
    // confirmDeleteBanner once the admin confirms.
    const confirmDeleteBanner = async () => {
        if (!pendingDelete) return;
        const { id } = pendingDelete;
        try {
            setDeletingId(id);
            const response = await bannerService.deleteBanner(id);
            if (response.success) {
                showSuccessToast('Success', 'Banner deleted successfully');
                fetchBanners();
            }
        } catch (error) {
            showErrorToast('Error', 'Failed to delete banner');
        } finally {
            setDeletingId(null);
            setPendingDelete(null);
        }
    };

    const moveBanner = async (index: number, direction: 'up' | 'down') => {
        const newBanners = [...banners];
        const swapIndex = direction === 'up' ? index - 1 : index + 1;
        if (swapIndex < 0 || swapIndex >= newBanners.length) return;

        [newBanners[index], newBanners[swapIndex]] = [newBanners[swapIndex], newBanners[index]];
        const orderedIds = newBanners.map(b => b.id);

        try {
            const response = await bannerService.reorderBanners(orderedIds);
            if (response.success) {
                setBanners(newBanners.map((b, i) => ({ ...b, displayOrder: i })));
            }
        } catch (error) {
            showErrorToast('Error', 'Failed to reorder banners');
        }
    };

    if (initialLoading) {
        return (
            <Card>
                <CardContent className="p-6">
                    <div className="flex items-center justify-center py-12">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-500"></div>
                        <span className="ml-3 text-slate-600">Loading banners...</span>
                    </div>
                </CardContent>
            </Card>
        );
    }


    return (
        <div className="space-y-6">
            {cropState && (
                <BannerCropModal
                    src={cropState.src}
                    aspect={TARGET_RATIO}
                    fileName={cropState.fileName}
                    onCancel={() => setCropState(null)}
                    onCropped={handleCropped}
                />
            )}

            {/* Delete confirmation — the trash icon opens this; nothing is removed
                until the admin confirms. */}
            <DeleteConfirmModal
                show={!!pendingDelete}
                title="Delete Banner"
                subtitle="This banner will be removed from the homepage carousel. This action cannot be undone."
                itemName={pendingDelete ? `Banner #${pendingDelete.order}` : undefined}
                confirmLabel="Delete Permanently"
                loading={!!deletingId}
                onConfirm={confirmDeleteBanner}
                onCancel={() => setPendingDelete(null)}
            />
            {/* Add New Banner */}
            <Card>
                <CardContent className="p-6">
                    <h3 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
                        <Plus className="h-5 w-5" />
                        Add New Banner
                    </h3>

                    <div className="space-y-4">
                        {/* Image Upload */}
                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-2">
                                Banner Image *
                            </label>

                            {/* Upload guidelines */}
                            <div className="mb-3 flex items-start gap-2.5 rounded-lg bg-brand-50 border border-brand-200 p-3">
                                <Info className="h-4 w-4 text-brand-600 shrink-0 mt-0.5" />
                                <div className="text-xs text-brand-800 leading-5">
                                    <p className="font-semibold">
                                        Recommended size: {REC_WIDTH} × {REC_HEIGHT} px (aspect ratio {TARGET_RATIO.toFixed(1)} : 1)
                                    </p>
                                    <ul className="text-brand-700 mt-1 list-disc pl-4 space-y-0.5">
                                        <li>After you pick an image, a <strong>crop tool opens</strong> — position &amp; zoom to the frame, which is locked to the live banner ratio ({REC_WIDTH} × {REC_HEIGHT} px, {TARGET_RATIO.toFixed(1)} : 1).</li>
                                        <li>Use a <strong>wide landscape</strong> image so there's room to crop cleanly.</li>
                                        <li>Keep text, logos &amp; key products in the <strong>centre</strong> — outer edges may be cropped on very wide screens.</li>
                                        <li>Format: <strong>JPG, PNG or WebP</strong> · keep under 5MB for fast loading.</li>
                                    </ul>
                                </div>
                            </div>

                            <div className="flex items-start gap-4">
                                <div
                                    role="button"
                                    tabIndex={0}
                                    className="flex-1 border-2 border-dashed border-slate-300 rounded-lg p-4 text-center cursor-pointer hover:border-slate-400 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 focus-visible:border-slate-500"
                                    onClick={() => fileInputRef.current?.click()}
                                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
                                >
                                    {filePreview ? (
                                        <div className="relative">
                                            <img
                                                src={filePreview}
                                                alt="Preview"
                                                className="max-h-48 mx-auto rounded-lg object-contain"
                                            />
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    clearNewForm();
                                                }}
                                                className="absolute top-2 right-2 bg-red-500 text-white rounded-full p-1 hover:bg-red-600"
                                            >
                                                <X className="h-4 w-4" />
                                            </button>
                                        </div>
                                    ) : (
                                        <div className="py-6">
                                            <Upload className="h-10 w-10 text-slate-400 mx-auto mb-2" />
                                            <p className="text-sm text-slate-500">
                                                Click to upload banner image
                                            </p>
                                            <p className="text-xs text-slate-400 mt-1">
                                                {REC_WIDTH} × {REC_HEIGHT} px · JPG, PNG or WebP · up to 5MB · crop opens after selecting
                                            </p>
                                        </div>
                                    )}
                                </div>
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept="image/jpeg,image/png,image/webp"
                                    onChange={handleFileSelect}
                                    className="hidden"
                                />
                            </div>
                        </div>

                        {/* Alt text + click-through link */}
                        <div className="space-y-3">
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">
                                    Alt Text (for accessibility)
                                </label>
                                <input
                                    type="text"
                                    value={newAltText}
                                    onChange={(e) => setNewAltText(e.target.value)}
                                    placeholder="Describe the banner image..."
                                    className="w-full h-10 px-3 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent text-sm"
                                />
                            </div>
                            <BannerLinkSelector
                                type={newLinkType}
                                setType={setNewLinkType}
                                value={newLinkValue}
                                setValue={setNewLinkValue}
                                categories={linkCategories}
                                products={linkProducts}
                            />
                        </div>

                        {/* Submit Button */}
                        {canManage && (
                            <button
                                onClick={handleAddBanner}
                                disabled={!selectedFile || uploading}
                                className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-white rounded-lg hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium transition-colors"
                            >
                                {uploading ? (
                                    <>
                                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                                        Uploading...
                                    </>
                                ) : (
                                    <>
                                        <Plus className="h-4 w-4" />
                                        Add Banner
                                    </>
                                )}
                            </button>
                        )}
                    </div>
                </CardContent>
            </Card>

            {/* Existing Banners */}
            <Card>
                <CardContent className="p-6">
                    <h3 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
                        <Image className="h-5 w-5" />
                        Banner Images ({banners.length})
                    </h3>

                    {banners.length === 0 ? (
                        <div className="text-center py-12 text-slate-500">
                            <Image className="h-12 w-12 mx-auto mb-3 text-slate-300" />
                            <p className="text-sm">No banners added yet.</p>
                            <p className="text-xs text-slate-400 mt-1">Add your first banner image above.</p>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {banners.map((banner, index) => (
                                <div
                                    key={banner.id}
                                    className={`border rounded-lg p-4 transition-colors ${
                                        banner.isActive ? 'border-slate-200 bg-white' : 'border-slate-200 bg-slate-50 opacity-60'
                                    }`}
                                >
                                    {editingId === banner.id ? (
                                        /* Edit Mode */
                                        <div className="space-y-3">
                                            <div className="flex items-start gap-4">
                                                <div
                                                    role="button"
                                                    tabIndex={0}
                                                    className="w-48 h-28 bg-slate-100 rounded-lg overflow-hidden flex-shrink-0 cursor-pointer border-2 border-dashed border-slate-300 hover:border-slate-400 outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 focus-visible:border-slate-500"
                                                    onClick={() => editFileInputRef.current?.click()}
                                                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
                                                >
                                                    <img
                                                        src={editFilePreview || banner.imageUrl}
                                                        alt={banner.altText || 'Banner'}
                                                        className="w-full h-full object-cover"
                                                    />
                                                </div>
                                                <input
                                                    ref={editFileInputRef}
                                                    type="file"
                                                    accept="image/jpeg,image/png,image/webp"
                                                    onChange={handleEditFileSelect}
                                                    className="hidden"
                                                />
                                                <div className="flex-1 space-y-2">
                                                    <input
                                                        type="text"
                                                        value={editAltText}
                                                        onChange={(e) => setEditAltText(e.target.value)}
                                                        placeholder="Alt text..."
                                                        className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/40 text-sm"
                                                    />
                                                    <p className="text-xs text-slate-400">Click the image to replace it</p>
                                                    <BannerLinkSelector
                                                        type={editLinkType}
                                                        setType={setEditLinkType}
                                                        value={editLinkValue}
                                                        setValue={setEditLinkValue}
                                                        categories={linkCategories}
                                                        products={linkProducts}
                                                    />
                                                    <div className="flex gap-2">
                                                        <button
                                                            onClick={() => handleUpdateBanner(banner.id)}
                                                            disabled={loading}
                                                            className="flex items-center gap-1 px-3 py-1.5 bg-brand-500 text-white rounded-lg text-xs font-medium hover:bg-brand-600 disabled:opacity-50"
                                                        >
                                                            <Save className="h-3 w-3" />
                                                            {loading ? 'Saving...' : 'Save'}
                                                        </button>
                                                        <button
                                                            onClick={cancelEditing}
                                                            className="flex items-center gap-1 px-3 py-1.5 border border-slate-300 rounded-lg text-xs font-medium hover:bg-slate-50"
                                                        >
                                                            Cancel
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    ) : (
                                        /* View Mode */
                                        <div className="flex items-center gap-4">
                                            {/* Reorder Controls */}
                                            <div className="flex flex-col gap-1">
                                                <button
                                                    onClick={() => moveBanner(index, 'up')}
                                                    disabled={index === 0}
                                                    className="p-1 text-slate-400 hover:text-slate-600 disabled:opacity-30 disabled:cursor-not-allowed"
                                                    title="Move up"
                                                >
                                                    <GripVertical className="h-4 w-4 rotate-180" />
                                                </button>
                                                <button
                                                    onClick={() => moveBanner(index, 'down')}
                                                    disabled={index === banners.length - 1}
                                                    className="p-1 text-slate-400 hover:text-slate-600 disabled:opacity-30 disabled:cursor-not-allowed"
                                                    title="Move down"
                                                >
                                                    <GripVertical className="h-4 w-4" />
                                                </button>
                                            </div>

                                            {/* Image Preview */}
                                            <div className="w-48 h-28 bg-slate-100 rounded-lg overflow-hidden flex-shrink-0">
                                                <img
                                                    src={banner.imageUrl}
                                                    alt={banner.altText || 'Banner'}
                                                    className="w-full h-full object-cover"
                                                />
                                            </div>

                                            {/* Banner Info */}
                                            <div className="flex-1 min-w-0">
                                                <p className="text-sm font-medium text-slate-900 truncate">
                                                    {banner.altText || 'No alt text'}
                                                </p>
                                                <p className="text-xs text-slate-500 mt-1">
                                                    Order: {banner.displayOrder + 1} | {banner.isActive ? 'Active' : 'Hidden'}
                                                </p>
                                                {banner.linkType && (
                                                    <p className="text-xs text-brand-600 mt-1 inline-flex items-center gap-1 truncate">
                                                        <Link2 className="h-3 w-3 flex-shrink-0" />
                                                        Links to {banner.linkType}: {banner.linkLabel || banner.linkValue}
                                                    </p>
                                                )}
                                            </div>

                                            {/* Actions */}
                                            {canManage && (
                                                <div className="flex items-center gap-2 flex-shrink-0">
                                                    <button
                                                        onClick={() => handleToggleActive(banner)}
                                                        className={`p-2 rounded-lg transition-colors ${
                                                            banner.isActive
                                                                ? 'text-green-600 hover:bg-green-50'
                                                                : 'text-slate-400 hover:bg-slate-100'
                                                        }`}
                                                        title={banner.isActive ? 'Hide banner' : 'Show banner'}
                                                    >
                                                        {banner.isActive ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                                                    </button>
                                                    <button
                                                        onClick={() => startEditing(banner)}
                                                        className="p-2 text-slate-500 hover:bg-slate-100 rounded-lg transition-colors"
                                                        title="Edit banner"
                                                    >
                                                        <Edit className="h-4 w-4" />
                                                    </button>
                                                    <button
                                                        onClick={() => setPendingDelete({ id: banner.id, order: banner.displayOrder + 1 })}
                                                        disabled={deletingId === banner.id}
                                                        className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                                                        title="Delete banner"
                                                    >
                                                        {deletingId === banner.id ? (
                                                            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-red-500"></div>
                                                        ) : (
                                                            <Trash2 className="h-4 w-4" />
                                                        )}
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
