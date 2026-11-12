'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Pencil, Trash2, Truck, Loader2, X, Upload, ImageIcon, AlertCircle } from 'lucide-react'
import { courierService, type Courier, type CourierInput } from '@/services/courierService'
import courierIntegrationService from '@/services/courierIntegrationService'
import { showSuccessToast, showErrorToast } from '@/lib/toast-utils'
import { uploadFileToCloudinary } from '@/lib/cloudinaryUpload'
import Dropdown from '@/components/UI/Dropdown'
import CourierBadge from '@/components/Shared/CourierBadge'

const REGION_LABELS: Record<'IN' | 'US' | 'BOTH', string> = {
  IN: 'Domestic (India · .in)',
  US: 'International (.com)',
  BOTH: 'Both (.in & .com)',
}

export default function CourierManagement() {
  const [couriers, setCouriers] = useState<Courier[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Courier | null>(null)
  const [liveActive, setLiveActive] = useState(false)

  useEffect(() => {
    courierIntegrationService
      .getSettings()
      .then((res) => setLiveActive(!!(res?.data?.enabled && res?.data?.connected)))
      .catch(() => setLiveActive(false))
  }, [])

  const load = async () => {
    try {
      setCouriers(await courierService.getCouriers())
    } catch (e) {
      showErrorToast(e instanceof Error ? e.message : 'Failed to load couriers')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const grouped = useMemo(() => ({
    IN: couriers.filter((c) => c.region === 'IN'),
    US: couriers.filter((c) => c.region === 'US'),
    BOTH: couriers.filter((c) => c.region === 'BOTH'),
  }), [couriers])

  const handleDelete = async (c: Courier) => {
    if (!window.confirm(`Delete courier "${c.name}"?`)) return
    try {
      await courierService.deleteCourier(c.id)
      showSuccessToast('Courier deleted')
      load()
    } catch (e) {
      showErrorToast(e instanceof Error ? e.message : 'Failed to delete courier')
    }
  }

  return (
    <div className="p-4 sm:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Truck className="w-6 h-6 text-[#e01a1b]" /> Courier Partners
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage the courier partners buyers can choose at checkout. Each product then picks which of these it ships with.
          </p>
        </div>
        <button
          onClick={() => { setEditing(null); setModalOpen(true) }}
          className="inline-flex items-center gap-2 bg-[#e01a1b] text-white px-4 py-2 rounded-lg hover:bg-[#c01718] transition-colors text-sm font-medium"
        >
          <Plus className="w-4 h-4" /> Add Courier
        </button>
      </div>

      {liveActive && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6">
          <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-800">
            Live courier (Delhivery) is handling domestic India shipping. These courier partners now apply to
            international (.com) orders and as a fallback when live courier is off.
          </p>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16 text-gray-400"><Loader2 className="w-6 h-6 animate-spin" /></div>
      ) : couriers.length === 0 ? (
        <div className="text-center py-16 text-gray-500 bg-white rounded-xl border border-gray-100">
          <Truck className="w-10 h-10 mx-auto text-gray-300 mb-3" />
          <p>No couriers yet. Add your first partner.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {(['IN', 'US', 'BOTH'] as const).map((region) => (
            grouped[region].length === 0 && region === 'BOTH' ? null :
            <div key={region}>
              <h2 className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-2">{REGION_LABELS[region]}</h2>
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm divide-y divide-gray-100">
                {grouped[region].length === 0 ? (
                  <p className="px-4 py-6 text-sm text-gray-400">No couriers in this region.</p>
                ) : grouped[region].map((c) => (
                  <div key={c.id} className="flex items-center gap-3 px-4 py-3">
                    <CourierBadge courier={c} className="w-9 h-9 rounded-lg" codeClassName="text-[10px]" />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-gray-900">{c.name}</p>
                      <p className="text-xs text-gray-400">{c.modes.map((m) => (m === 'AIR' ? 'Air' : region === 'IN' ? 'Surface' : region === 'BOTH' ? 'Surface / Sea' : 'Sea')).join(' · ') || '—'}</p>
                    </div>
                    {!c.isActive && <span className="text-[10px] font-semibold text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">Inactive</span>}
                    <button onClick={() => { setEditing(c); setModalOpen(true) }} className="p-1.5 text-gray-500 hover:text-[#e01a1b] hover:bg-red-50 rounded" title="Edit"><Pencil className="w-4 h-4" /></button>
                    <button onClick={() => handleDelete(c)} className="p-1.5 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded" title="Delete"><Trash2 className="w-4 h-4" /></button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {modalOpen && (
        <CourierModal
          courier={editing}
          onClose={() => setModalOpen(false)}
          onSaved={() => { setModalOpen(false); setLoading(true); load() }}
        />
      )}
    </div>
  )
}

const emptyForm: CourierInput = { name: '', code: '', color: '#1a1a1a', logo: null, region: 'IN', modes: [], isActive: true, sortOrder: 0 }

function CourierModal({ courier, onClose, onSaved }: { courier: Courier | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<CourierInput>(courier ? { ...courier } : { ...emptyForm })
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const set = <K extends keyof CourierInput>(k: K, v: CourierInput[K]) => setForm((f) => ({ ...f, [k]: v }))

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file
    if (!file) return
    if (!file.type.startsWith('image/')) return showErrorToast('Please choose an image file')
    if (file.size > 2 * 1024 * 1024) return showErrorToast('Logo must be under 2 MB')
    setUploading(true)
    try {
      const { url } = await uploadFileToCloudinary(file, 'couriers')
      set('logo', url)
    } catch (err) {
      showErrorToast(err instanceof Error ? err.message : 'Failed to upload logo')
    } finally {
      setUploading(false)
    }
  }

  const toggleMode = (m: 'AIR' | 'SHIP') => {
    const cur = (form.modes || []) as ('AIR' | 'SHIP')[]
    set('modes', cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m])
  }

  const submit = async () => {
    if (!form.name?.trim()) return showErrorToast('Name is required')
    if (!form.code?.trim()) return showErrorToast('Code is required')
    if (!(form.modes || []).length) return showErrorToast('Select at least one transport mode')
    setSaving(true)
    try {
      if (courier) {
        await courierService.updateCourier(courier.id, form)
        showSuccessToast('Courier updated')
      } else {
        await courierService.createCourier(form)
        showSuccessToast('Courier created')
      }
      onSaved()
    } catch (e) {
      showErrorToast(e instanceof Error ? e.message : 'Failed to save courier')
    } finally {
      setSaving(false)
    }
  }

  const shipLabel = form.region === 'IN' ? 'Surface / Road' : form.region === 'BOTH' ? 'Surface / Sea Freight' : 'Sea Freight'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900">{courier ? 'Edit Courier' : 'Add Courier'}</h2>
          <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-700 rounded"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
              <input value={form.name || ''} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Blue Dart"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#e01a1b]" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Code *</label>
              <input value={form.code || ''} onChange={(e) => set('code', e.target.value)} placeholder="BD" maxLength={5}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#e01a1b] uppercase" />
            </div>
          </div>

          {/* Logo (optional) — takes priority over the colour badge when present */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Logo <span className="font-normal text-gray-400">(optional)</span></label>
            <input ref={fileRef} type="file" accept="image/*" onChange={handleLogoUpload} className="hidden" />
            {form.logo ? (
              <div className="flex items-center gap-3">
                <div className="w-14 h-14 rounded-lg border border-gray-200 bg-white flex items-center justify-center overflow-hidden shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={form.logo} alt="Courier logo" className="max-w-full max-h-full object-contain" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
                    className="inline-flex items-center gap-1.5 text-sm text-gray-700 hover:text-[#e01a1b] disabled:opacity-60">
                    {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} Replace
                  </button>
                  <button type="button" onClick={() => set('logo', null)} disabled={uploading}
                    className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-red-600 disabled:opacity-60">
                    <Trash2 className="w-4 h-4" /> Remove
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
                className="w-full flex items-center justify-center gap-2 border-2 border-dashed border-gray-300 rounded-lg py-4 text-sm text-gray-500 hover:border-[#e01a1b] hover:text-[#e01a1b] transition-colors disabled:opacity-60">
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImageIcon className="w-4 h-4" />}
                {uploading ? 'Uploading…' : 'Upload logo image'}
              </button>
            )}
            <p className="text-xs text-gray-400 mt-1.5">If a logo is uploaded it&apos;s used instead of the colour &amp; code badge. Max 2&nbsp;MB.</p>
          </div>

          <div className="grid grid-cols-3 gap-3 items-end">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Badge colour</label>
              <input type="color" value={form.color || '#1a1a1a'} onChange={(e) => set('color', e.target.value)} disabled={!!form.logo}
                className="w-full h-10 border border-gray-300 rounded-lg cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed" />
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Preview</label>
              <span className="inline-flex items-center gap-2 rounded-full ring-1 ring-gray-200 px-2.5 py-1 text-sm">
                <CourierBadge courier={{ code: (form.code || '??').toUpperCase(), color: form.color, logo: form.logo, name: form.name }} className="w-6 h-6 rounded" codeClassName="text-[9px]" />
                {form.name || 'Courier name'}
              </span>
            </div>
          </div>

          <Dropdown
            label="Region *"
            value={form.region || 'IN'}
            onChange={(v) => set('region', v as 'IN' | 'US' | 'BOTH')}
            options={[
              { value: 'IN', label: 'Domestic (India · .in)' },
              { value: 'US', label: 'International (.com)' },
              { value: 'BOTH', label: 'Both (.in & .com)' },
            ]}
          />

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Transport modes *</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={(form.modes || []).includes('AIR')} onChange={() => toggleMode('AIR')} /> Air
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={(form.modes || []).includes('SHIP')} onChange={() => toggleMode('SHIP')} /> {shipLabel}
              </label>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Tracking website URL <span className="font-normal text-gray-400">(optional)</span></label>
            <input value={form.trackingUrl || ''} onChange={(e) => set('trackingUrl', e.target.value)} placeholder="https://track.example.com/{tracking}"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#e01a1b]" />
            <p className="text-xs text-gray-400 mt-1.5">Shown to the customer when they track this order. Use <code className="rounded bg-gray-100 px-1">{'{tracking}'}</code> where the tracking ID goes — otherwise it links to the courier&apos;s tracking page.</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Sort order</label>
              <input type="number" value={form.sortOrder ?? 0} onChange={(e) => set('sortOrder', Number(e.target.value))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#e01a1b]" />
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700 mt-6">
              <input type="checkbox" checked={form.isActive ?? true} onChange={(e) => set('isActive', e.target.checked)} /> Active
            </label>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
          <button onClick={submit} disabled={saving} className="inline-flex items-center gap-2 bg-[#e01a1b] text-white px-4 py-2 rounded-lg hover:bg-[#c01718] text-sm font-medium disabled:opacity-60">
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            {courier ? 'Save changes' : 'Add courier'}
          </button>
        </div>
      </div>
    </div>
  )
}
