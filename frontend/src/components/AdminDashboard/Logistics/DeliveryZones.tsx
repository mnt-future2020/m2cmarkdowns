'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Country, State, City } from 'country-state-city';
import { Card, CardContent } from '@/components/UI/Card';
import { Button } from '@/components/UI/Button';
import { MapPin, Plus, Pencil, Trash2, X, Search, Truck, Percent, Save, ChevronDown, Check, AlertCircle } from 'lucide-react';
import { showSuccessToast, showErrorToast } from '@/lib/toast-utils';
import DeleteConfirmModal from '@/components/UI/DeleteConfirmModal';
import { deliveryZoneService, type DeliveryZone, type ZoneState, type ZonePayload } from '@/services/deliveryZoneService';
import courierIntegrationService from '@/services/courierIntegrationService';
import { hasPermission } from '@/lib/auth';

const inr = (n: number) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export default function DeliveryZones() {
  const [zones, setZones] = useState<DeliveryZone[]>([]);
  const [gst, setGst] = useState(0);
  const [gstInput, setGstInput] = useState('0');
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<{ mode: 'create' | 'edit'; zone?: DeliveryZone } | null>(null);
  const [del, setDel] = useState<DeliveryZone | null>(null);
  const [busy, setBusy] = useState(false);
  const canEdit = hasPermission('all_products:edit');
  const canDelete = hasPermission('all_products:delete');
  const canCreate = hasPermission('all_products:create');
  const [liveActive, setLiveActive] = useState(false);

  useEffect(() => {
    courierIntegrationService
      .getSettings()
      .then((res) => setLiveActive(!!(res?.data?.enabled && res?.data?.connected)))
      .catch(() => setLiveActive(false));
  }, []);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await deliveryZoneService.getZones();
      setZones(res.data || []);
      setGst(res.shippingGstPercentage || 0);
      setGstInput(String(res.shippingGstPercentage || 0));
    } catch { setZones([]); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const saveGst = async () => {
    try {
      setBusy(true);
      const res = await deliveryZoneService.updateShippingGst(Number(gstInput) || 0);
      setGst(res.shippingGstPercentage || 0);
      showSuccessToast('Saved', 'Shipping GST updated.');
    } catch (e: any) { showErrorToast('Failed', e?.response?.data?.message || 'Could not save.'); }
    finally { setBusy(false); }
  };

  const confirmDelete = async () => {
    if (!del) return;
    try {
      setBusy(true);
      await deliveryZoneService.deleteZone(del.id);
      showSuccessToast('Deleted', `${del.name} removed.`);
      setDel(null); load();
    } catch (e: any) { showErrorToast('Failed', e?.response?.data?.message || 'Could not delete.'); }
    finally { setBusy(false); }
  };

  const zoneScope = (z: DeliveryZone) => {
    const st = z.allStates ? 'All states' : `${z.states.length} state${z.states.length === 1 ? '' : 's'}`;
    const cy = z.allStates || z.allCities ? 'all cities' : `${z.cities.length} cit${z.cities.length === 1 ? 'y' : 'ies'}`;
    return `${st} · ${cy}`;
  };

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-[#e01a1b]/10 text-[#e01a1b]"><MapPin className="h-5 w-5" /></span>
          <div>
            <h1 className="text-xl font-bold text-slate-900">Delivery Zones</h1>
            <p className="text-sm text-slate-500">Where M2C delivers and the flat fee added on top of the weight-based rate.</p>
          </div>
        </div>
        {canCreate && <Button onClick={() => setModal({ mode: 'create' })}><Plus className="mr-1.5 h-4 w-4" /> Add Zone</Button>}
      </div>

      {liveActive && (
        <div className="mb-5 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-xs text-amber-800">
            Live courier (Delhivery) sets the domestic carrier and (if live rates are on) the domestic shipping rate.
            Delivery zones still control destination availability, the flat delivery fee, and shipping tax — keep them
            configured.
          </p>
        </div>
      )}

      {/* Shipping GST */}
      <Card className="mb-5">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-amber-50 text-amber-600"><Percent className="h-4 w-4" /></span>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Shipping GST %</label>
            <input type="number" min={0} step="0.01" value={gstInput} onChange={(e) => setGstInput(e.target.value)} disabled={!canEdit}
              className="w-32 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-[#e01a1b] focus:ring-2 focus:ring-[#e01a1b]/15" />
          </div>
          <p className="mb-2 flex-1 min-w-[200px] text-xs text-slate-400">Applied to the shipping total (weight rate + zone fee) on the order summary & invoice. Set 0 for no shipping tax.</p>
          {canEdit && <Button variant="outline" onClick={saveGst} disabled={busy || Number(gstInput) === gst}><Save className="mr-1.5 h-4 w-4" />Save</Button>}
        </CardContent>
      </Card>

      {loading ? (
        <div className="py-20 text-center text-slate-400">Loading…</div>
      ) : zones.length === 0 ? (
        <Card><CardContent className="py-16 text-center">
          <Truck className="mx-auto h-10 w-10 text-slate-300" />
          <p className="mt-3 font-semibold text-slate-700">No delivery zones yet</p>
          <p className="text-sm text-slate-500">Add a zone to decide where you deliver. Until a zone matches, checkout is blocked for that location.</p>
        </CardContent></Card>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="hidden gap-3 border-b border-slate-100 bg-slate-50 px-4 py-2.5 text-[11px] font-bold uppercase tracking-wide text-slate-500 lg:grid lg:grid-cols-[1.6fr_1fr_1.8fr_0.8fr_0.7fr_1fr]">
            <div>Zone</div><div>Country</div><div>Scope</div><div>Flat Fee</div><div>Status</div><div className="text-right">Actions</div>
          </div>
          {zones.map((z) => (
            <div key={z.id} className="grid grid-cols-1 gap-3 border-b border-slate-50 px-4 py-3 last:border-0 hover:bg-slate-50/60 lg:grid-cols-[1.6fr_1fr_1.8fr_0.8fr_0.7fr_1fr] lg:items-center">
              <div className="font-semibold text-slate-800">{z.name}</div>
              <div className="text-sm text-slate-600">{z.countryName} <span className="text-slate-400">({z.countryIso})</span></div>
              <div className="text-[13px] text-slate-600">
                {zoneScope(z)}
                {!z.allStates && z.states.length > 0 && <div className="mt-0.5 truncate text-[11px] text-slate-400">{z.states.map((s) => s.name).join(', ')}</div>}
              </div>
              <div className="text-sm font-semibold text-slate-800">{inr(z.flatFee)}</div>
              <div><span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${z.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{z.isActive ? 'Active' : 'Inactive'}</span></div>
              <div className="flex items-center justify-end gap-1.5">
                {canEdit && <button title="Edit" onClick={() => setModal({ mode: 'edit', zone: z })} className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-50"><Pencil className="h-3.5 w-3.5" /></button>}
                {canDelete && <button title="Delete" onClick={() => setDel(z)} className="rounded-lg border border-red-200 bg-white p-1.5 text-red-500 hover:text-red-700 hover:bg-red-50"><Trash2 className="h-3.5 w-3.5" /></button>}
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && <ZoneModal mode={modal.mode} zone={modal.zone} zones={zones} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />}
      <DeleteConfirmModal show={!!del} title="Delete Delivery Zone" itemName={del?.name || ''} itemDetail="Orders to this zone will no longer be accepted (unless another zone covers it)." loading={busy} onConfirm={confirmDelete} onCancel={() => setDel(null)} />
    </div>
  );
}

function ZoneModal({ mode, zone, zones, onClose, onSaved }: { mode: 'create' | 'edit'; zone?: DeliveryZone; zones: DeliveryZone[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(zone?.name || '');
  const [countryIso, setCountryIso] = useState(zone?.countryIso || 'IN');
  const [allStates, setAllStates] = useState(zone?.allStates ?? false);
  const [selStates, setSelStates] = useState<ZoneState[]>(zone?.states || []);
  const [allCities, setAllCities] = useState(zone?.allCities ?? true);
  const [selCities, setSelCities] = useState<string[]>(zone?.cities || []);
  const [flatFee, setFlatFee] = useState(String(zone?.flatFee ?? 0));
  const [isActive, setIsActive] = useState(zone?.isActive ?? true);
  const [stateSearch, setStateSearch] = useState('');
  const [citySearch, setCitySearch] = useState('');
  const [saving, setSaving] = useState(false);

  // Custom country picker — replaces the native <select>, whose browser-rendered
  // list of ~250 countries overflowed the viewport. Contained, searchable panel.
  const [countryOpen, setCountryOpen] = useState(false);
  const [countrySearch, setCountrySearch] = useState('');
  const countryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!countryOpen) return;
    const onDown = (e: MouseEvent) => {
      if (countryRef.current && !countryRef.current.contains(e.target as Node)) setCountryOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCountryOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [countryOpen]);

  // What other zones already cover — so we never create an overlapping zone.
  // Fully-covered countries/states and already-taken city names get disabled.
  const n = (s: string) => String(s || '').trim().toLowerCase();
  const coverage = useMemo(() => {
    const others = (zones || []).filter((z) => z.id !== zone?.id);
    const fullCountries = new Set<string>();
    const fullStates = new Map<string, Set<string>>();   // countryIso → stateIso set (whole-state)
    const coveredCities = new Map<string, Set<string>>(); // countryIso → city-name set
    const anyCoverage = new Set<string>();                // countryIso with any coverage
    for (const z of others) {
      const ci = z.countryIso.toUpperCase();
      anyCoverage.add(ci);
      if (z.allStates) { fullCountries.add(ci); continue; }
      if (z.allCities) {
        if (!fullStates.has(ci)) fullStates.set(ci, new Set());
        for (const st of z.states) fullStates.get(ci)!.add(st.iso.toUpperCase());
      } else {
        if (!coveredCities.has(ci)) coveredCities.set(ci, new Set());
        for (const c of z.cities) coveredCities.get(ci)!.add(n(c));
      }
    }
    return { fullCountries, fullStates, coveredCities, anyCoverage };
  }, [zones, zone?.id]);

  const ciU = countryIso.toUpperCase();
  const countryFull = coverage.fullCountries.has(ciU);
  const stateFullSet = coverage.fullStates.get(ciU) || new Set<string>();
  const cityCoveredSet = coverage.coveredCities.get(ciU) || new Set<string>();
  const countryHasAny = coverage.anyCoverage.has(ciU);

  const countries = useMemo(() => Country.getAllCountries(), []);
  const selectedCountry = useMemo(() => countries.find((c) => c.isoCode === countryIso), [countries, countryIso]);
  const filteredCountries = useMemo(() => {
    const q = countrySearch.trim().toLowerCase();
    return q ? countries.filter((c) => c.name.toLowerCase().includes(q)) : countries;
  }, [countries, countrySearch]);
  const selectCountry = (iso: string) => {
    setCountryIso(iso);
    setSelStates([]);
    setSelCities([]);
    setAllStates(false);
    setAllCities(true);
    setCountryOpen(false);
    setCountrySearch('');
  };
  const states = useMemo(() => State.getStatesOfCountry(countryIso) || [], [countryIso]);
  const cities = useMemo(() => {
    if (allStates) return [] as string[];
    const names = new Set<string>();
    for (const s of selStates) (City.getCitiesOfState(countryIso, s.iso) || []).forEach((c) => names.add(c.name));
    return Array.from(names).sort();
  }, [countryIso, selStates, allStates]);

  // "All cities" would overlap if any of the selected states' cities are already taken.
  const allCitiesConflict = useMemo(() => cities.some((c) => cityCoveredSet.has(n(c))), [cities, cityCoveredSet]);
  // When a conflict exists, force individual city selection (all-cities not allowed).
  useEffect(() => { if (allCitiesConflict && allCities) setAllCities(false); }, [allCitiesConflict, allCities]);

  const toggleState = (iso: string, nm: string) => {
    if (countryFull || stateFullSet.has(iso.toUpperCase())) return; // already covered
    setSelStates((prev) => prev.some((s) => s.iso === iso) ? prev.filter((s) => s.iso !== iso) : [...prev, { iso, name: nm }]);
  };
  const toggleCity = (c: string) => {
    if (countryFull || cityCoveredSet.has(n(c))) return; // already covered
    setSelCities((prev) => prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]);
  };

  const save = async () => {
    const country = countries.find((c) => c.isoCode === countryIso);
    if (!name.trim()) return showErrorToast('Required', 'Enter a zone name.');
    if (!country) return showErrorToast('Required', 'Select a country.');
    if (!allStates && selStates.length === 0) return showErrorToast('Required', 'Select at least one state, or tick "All states".');
    const payload: ZonePayload = {
      name: name.trim(),
      countryIso,
      countryName: country.name,
      allStates,
      states: allStates ? [] : selStates,
      allCities: allStates ? true : allCities,
      cities: (allStates || allCities) ? [] : selCities,
      flatFee: Math.max(0, Number(flatFee) || 0),
      isActive,
    };
    try {
      setSaving(true);
      if (mode === 'create') await deliveryZoneService.createZone(payload);
      else await deliveryZoneService.updateZone(zone!.id, payload);
      showSuccessToast('Saved', `Zone ${mode === 'create' ? 'created' : 'updated'}.`);
      onSaved();
    } catch (e: any) { showErrorToast('Failed', e?.response?.data?.message || 'Could not save.'); }
    finally { setSaving(false); }
  };

  const filteredStates = states.filter((s) => s.name.toLowerCase().includes(stateSearch.toLowerCase()));
  const filteredCities = cities.filter((c) => c.toLowerCase().includes(citySearch.toLowerCase())).slice(0, 300);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h3 className="text-base font-bold text-slate-900">{mode === 'create' ? 'Add Delivery Zone' : 'Edit Delivery Zone'}</h3>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-full text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[13px] font-semibold text-slate-700">Zone name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. South India Metro" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-[#e01a1b] focus:ring-2 focus:ring-[#e01a1b]/15" />
            </div>
            <div>
              <label className="mb-1 block text-[13px] font-semibold text-slate-700">Country</label>
              <div className="relative" ref={countryRef}>
                <button
                  type="button"
                  onClick={() => setCountryOpen((o) => !o)}
                  className="flex w-full items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-left text-sm outline-none focus:border-[#e01a1b] focus:ring-2 focus:ring-[#e01a1b]/15"
                >
                  <span className="truncate">{selectedCountry ? `${selectedCountry.flag} ${selectedCountry.name}` : 'Select a country'}</span>
                  <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${countryOpen ? 'rotate-180' : ''}`} />
                </button>
                {countryOpen && (
                  <div className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
                    <div className="relative border-b border-slate-100 p-2">
                      <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                      <input autoFocus value={countrySearch} onChange={(e) => setCountrySearch(e.target.value)} placeholder="Search countries…" className="w-full rounded-md border border-slate-200 py-1.5 pl-8 pr-2 text-sm outline-none" />
                    </div>
                    <div className="max-h-56 overflow-y-auto p-1">
                      {filteredCountries.length === 0 ? (
                        <p className="py-3 text-center text-xs text-slate-400">No countries</p>
                      ) : (
                        filteredCountries.map((c) => {
                          const done = coverage.fullCountries.has(c.isoCode.toUpperCase());
                          const selected = c.isoCode === countryIso;
                          return (
                            <button
                              key={c.isoCode}
                              type="button"
                              disabled={done}
                              onClick={() => selectCountry(c.isoCode)}
                              title={done ? 'Fully covered by another zone' : undefined}
                              className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] ${done ? 'cursor-not-allowed text-slate-300' : selected ? 'bg-[#e01a1b]/10 text-[#e01a1b]' : 'text-slate-700 hover:bg-slate-50'}`}
                            >
                              <span className="truncate">{c.flag} {c.name}{done ? ' — fully covered' : ''}</span>
                              {selected && <Check className="h-3.5 w-3.5 shrink-0" />}
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* States */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-[13px] font-semibold text-slate-700">States</label>
              <label className={`flex items-center gap-1.5 text-[12px] font-medium ${countryFull || countryHasAny ? 'text-slate-300' : 'text-slate-600'}`} title={countryFull || countryHasAny ? 'Some of this country is already covered by another zone' : undefined}><input type="checkbox" disabled={countryFull || countryHasAny} checked={allStates} onChange={(e) => { setAllStates(e.target.checked); if (e.target.checked) { setSelStates([]); setSelCities([]); } }} className="accent-[#e01a1b]" /> All states in {countries.find((c) => c.isoCode === countryIso)?.name}</label>
            </div>
            {!allStates && (
              <div className="rounded-xl border border-slate-200">
                <div className="relative border-b border-slate-100 p-2"><Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" /><input value={stateSearch} onChange={(e) => setStateSearch(e.target.value)} placeholder="Search states…" className="w-full rounded-md border border-slate-200 py-1.5 pl-8 pr-2 text-sm outline-none" /></div>
                <div className="max-h-40 overflow-y-auto p-2">
                  {filteredStates.length === 0 ? <p className="py-3 text-center text-xs text-slate-400">No states</p> :
                    <div className="grid grid-cols-2 gap-1">
                      {filteredStates.map((s) => {
                        const covered = countryFull || stateFullSet.has(s.isoCode.toUpperCase());
                        return (
                          <label key={s.isoCode} title={covered ? 'Already covered by another zone' : undefined} className={`flex items-center gap-1.5 rounded px-1.5 py-1 text-[13px] ${covered ? 'cursor-not-allowed text-slate-300' : 'cursor-pointer text-slate-700 hover:bg-slate-50'}`}>
                            <input type="checkbox" disabled={covered} checked={selStates.some((x) => x.iso === s.isoCode)} onChange={() => toggleState(s.isoCode, s.name)} className="accent-[#e01a1b]" />{s.name}{covered ? ' ✓' : ''}
                          </label>
                        );
                      })}
                    </div>}
                </div>
                {selStates.length > 0 && <div className="border-t border-slate-100 px-2 py-1.5 text-[11px] text-slate-500">{selStates.length} selected</div>}
              </div>
            )}
          </div>

          {/* Cities — only when specific states chosen */}
          {!allStates && selStates.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-[13px] font-semibold text-slate-700">Cities</label>
                <label className={`flex items-center gap-1.5 text-[12px] font-medium ${allCitiesConflict ? 'text-slate-300' : 'text-slate-600'}`} title={allCitiesConflict ? 'Some cities in the selected states are already covered — pick cities individually' : undefined}><input type="checkbox" disabled={allCitiesConflict} checked={allCities && !allCitiesConflict} onChange={(e) => { setAllCities(e.target.checked); if (e.target.checked) setSelCities([]); }} className="accent-[#e01a1b]" /> All cities in selected states</label>
              </div>
              {!allCities && (
                <div className="rounded-xl border border-slate-200">
                  <div className="relative border-b border-slate-100 p-2"><Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" /><input value={citySearch} onChange={(e) => setCitySearch(e.target.value)} placeholder="Search cities…" className="w-full rounded-md border border-slate-200 py-1.5 pl-8 pr-2 text-sm outline-none" /></div>
                  <div className="max-h-40 overflow-y-auto p-2">
                    {filteredCities.length === 0 ? <p className="py-3 text-center text-xs text-slate-400">No cities</p> :
                      <div className="grid grid-cols-2 gap-1">
                        {filteredCities.map((c) => {
                          const covered = countryFull || cityCoveredSet.has(n(c));
                          return (
                            <label key={c} title={covered ? 'Already covered by another zone' : undefined} className={`flex items-center gap-1.5 rounded px-1.5 py-1 text-[13px] ${covered ? 'cursor-not-allowed text-slate-300' : 'cursor-pointer text-slate-700 hover:bg-slate-50'}`}>
                              <input type="checkbox" disabled={covered} checked={selCities.includes(c)} onChange={() => toggleCity(c)} className="accent-[#e01a1b]" />{c}{covered ? ' ✓' : ''}
                            </label>
                          );
                        })}
                      </div>}
                  </div>
                  {selCities.length > 0 && <div className="border-t border-slate-100 px-2 py-1.5 text-[11px] text-slate-500">{selCities.length} selected{cities.length > 300 ? ' · showing first 300 — search to narrow' : ''}</div>}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[13px] font-semibold text-slate-700">Flat delivery fee (₹)</label>
              <input type="number" min={0} step="0.01" value={flatFee} onChange={(e) => setFlatFee(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-[#e01a1b] focus:ring-2 focus:ring-[#e01a1b]/15" />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 pb-2 text-sm font-medium text-slate-700"><input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="accent-[#e01a1b]" /> Active</label>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Zone'}</Button>
        </div>
      </div>
    </div>
  );
}
