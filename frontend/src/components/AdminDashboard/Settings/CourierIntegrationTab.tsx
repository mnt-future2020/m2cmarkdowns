'use client';

import { useState, useEffect } from 'react';
import { Truck, RefreshCw, Check, AlertCircle, Key, Plug, CheckCircle2, XCircle, MapPin } from 'lucide-react';
import Dropdown from '@/components/UI/Dropdown';
import courierIntegrationService, {
  CourierIntegrationSettings,
  ServiceabilityResult,
} from '@/services/courierIntegrationService';
import { showSuccessToast, showErrorToast } from '@/lib/toast-utils';

const ENVIRONMENT_OPTIONS = [
  { value: 'staging', label: 'Staging (test)' },
  { value: 'production', label: 'Production (live)' },
];

const DEFAULTS: CourierIntegrationSettings = {
  provider: 'delhivery',
  enabled: false,
  connected: false,
  environment: 'staging',
  pickupName: '',
  originPincode: '',
  clientName: '',
  useLiveRates: false,
  defaultWeightGrams: 500,
  defaultLengthCm: 10,
  defaultWidthCm: 10,
  defaultHeightCm: 10,
  hasToken: false,
  tokenPreview: '',
  lastTestAt: null,
  lastTestError: null,
};

const fieldCls =
  'w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent disabled:bg-slate-100';

export default function CourierIntegrationTab() {
  const [form, setForm] = useState<CourierIntegrationSettings>(DEFAULTS);
  // The real token is never returned by the API. This holds only a newly typed
  // value; it starts blank and is sent to the backend only when non-empty.
  const [apiToken, setApiToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  // Pincode serviceability utility
  const [pincodeQuery, setPincodeQuery] = useState('');
  const [checkingPincode, setCheckingPincode] = useState(false);
  const [serviceability, setServiceability] = useState<ServiceabilityResult | null>(null);

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      setLoading(true);
      const res = await courierIntegrationService.getSettings();
      if (res.success && res.data) {
        const { id, ...rest } = res.data;
        setForm({ ...DEFAULTS, ...rest });
      }
    } catch {
      showErrorToast('Failed to load courier integration settings');
    } finally {
      setLoading(false);
    }
  };

  const setNum = (key: keyof CourierIntegrationSettings, raw: string) => {
    const n = raw === '' ? 0 : Number(raw);
    setForm((f) => ({ ...f, [key]: Number.isNaN(n) ? 0 : n }));
  };

  // Register a pickup location (ClientWarehouse) with Delhivery so the pickup name
  // is recognised. The name becomes the integration's pickupName on success.
  const [pickupForm, setPickupForm] = useState({ name: '', phone: '', email: '', address: '', city: '', state: '', pincode: '' });
  const [registering, setRegistering] = useState(false);
  const [generatingSecret, setGeneratingSecret] = useState(false);
  const handleGenerateWebhook = async () => {
    try {
      setGeneratingSecret(true);
      const res = await courierIntegrationService.generateWebhookSecret();
      if (res.success && res.data) {
        const { id, ...rest } = res.data;
        setForm({ ...DEFAULTS, ...rest });
        showSuccessToast('Webhook secret generated', 'Register the webhook URL below in your Delhivery panel.');
      }
    } catch (err: any) {
      showErrorToast('Failed', err?.response?.data?.error || 'Could not generate the webhook secret.');
    } finally {
      setGeneratingSecret(false);
    }
  };

  const handleRegisterPickup = async () => {
    if (!/^\d{6}$/.test(pickupForm.pincode)) {
      showErrorToast('Invalid pincode', 'Pickup pincode must be a 6-digit number.');
      return;
    }
    try {
      setRegistering(true);
      const res = await courierIntegrationService.registerPickup(pickupForm);
      if (res.success) {
        showSuccessToast('Pickup Registered', res.message || 'Pickup location registered with Delhivery.');
        await fetchSettings();
      }
    } catch (err: any) {
      showErrorToast('Registration failed', err?.response?.data?.error || err?.message || 'Could not register the pickup location.');
    } finally {
      setRegistering(false);
    }
  };

  // Enabling requires a stored token + a pickup name (backend rejects otherwise).
  const canEnable = form.hasToken && !!form.pickupName.trim();

  const buildPayload = (): Partial<CourierIntegrationSettings> & { apiToken?: string } => {
    const payload: Partial<CourierIntegrationSettings> & { apiToken?: string } = {
      provider: form.provider,
      enabled: form.enabled,
      environment: form.environment,
      pickupName: form.pickupName,
      originPincode: form.originPincode,
      clientName: form.clientName,
      useLiveRates: form.useLiveRates,
      defaultWeightGrams: form.defaultWeightGrams,
      defaultLengthCm: form.defaultLengthCm,
      defaultWidthCm: form.defaultWidthCm,
      defaultHeightCm: form.defaultHeightCm,
    };
    // Only send the token if the admin actually typed a new one.
    if (apiToken.trim()) payload.apiToken = apiToken.trim();
    return payload;
  };

  const handleSave = async () => {
    if (form.originPincode && !/^\d{6}$/.test(form.originPincode)) {
      showErrorToast('Invalid pincode', 'Origin pincode must be a 6-digit number.');
      return;
    }
    if (form.enabled && !canEnable) {
      showErrorToast('Cannot enable', 'Add an API token and pickup location name before enabling.');
      return;
    }
    try {
      setSaving(true);
      const res = await courierIntegrationService.updateSettings(buildPayload());
      if (res.success) {
        showSuccessToast('Courier Integration Updated', res.message || 'Settings saved successfully.');
        setApiToken(''); // clear the typed token; we never keep it around
        await fetchSettings(); // refresh connected / tokenPreview
      }
    } catch (err: any) {
      showErrorToast('Save failed', err?.response?.data?.message || err?.message || 'Failed to update settings.');
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    try {
      setTesting(true);
      const res = await courierIntegrationService.testConnection();
      if (res.success) {
        showSuccessToast('Connection OK', res.message || 'Successfully connected to Delhivery.');
      } else {
        showErrorToast('Connection failed', res.message || 'Could not connect to Delhivery.');
      }
      await fetchSettings(); // refresh connected + lastTestAt/lastTestError
    } catch (err: any) {
      showErrorToast('Connection failed', err?.response?.data?.message || err?.message || 'Could not connect to Delhivery.');
      await fetchSettings();
    } finally {
      setTesting(false);
    }
  };

  const handleCheckServiceability = async () => {
    if (!/^\d{6}$/.test(pincodeQuery)) {
      showErrorToast('Invalid pincode', 'Enter a 6-digit pincode.');
      return;
    }
    try {
      setCheckingPincode(true);
      setServiceability(null);
      const res = await courierIntegrationService.checkServiceability(pincodeQuery);
      if (res.success) {
        setServiceability(res.data);
      }
    } catch (err: any) {
      showErrorToast('Check failed', err?.response?.data?.message || err?.message || 'Could not check serviceability.');
    } finally {
      setCheckingPincode(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="h-6 w-6 animate-spin text-slate-400" />
      </div>
    );
  }

  const lastTestLabel = form.lastTestAt
    ? new Date(form.lastTestAt).toLocaleString()
    : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-lg font-bold text-slate-900">Live Courier (Delhivery)</h2>
        <p className="text-sm text-slate-600 mt-1">
          Connect Delhivery to auto-create shipments and (optionally) pull live shipping rates for India orders.
        </p>
      </div>

      {/* Connection */}
      <div className="bg-white rounded-xl border border-slate-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-slate-900">Connection</h3>
          {/* Connected / not-connected status pill */}
          {form.connected ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-green-50 text-green-700 border border-green-200">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Connected
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-600 border border-slate-200">
              <XCircle className="h-3.5 w-3.5" />
              Not connected
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-slate-700 mb-2">API token</label>
            <div className="relative">
              <Key className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <input
                type="password"
                autoComplete="off"
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                placeholder={form.hasToken ? (form.tokenPreview || '••••••••') : 'Paste your Delhivery API token'}
                className={`${fieldCls} pl-10`}
              />
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Generate this in one.delhivery.com → Settings → API Setup.
              {form.hasToken && ' Leave blank to keep the existing token.'}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Environment</label>
            <Dropdown
              id="courier-environment"
              value={form.environment}
              options={ENVIRONMENT_OPTIONS}
              onChange={(v) =>
                setForm((f) => ({
                  ...f,
                  environment: (Array.isArray(v) ? v[0] : v) as CourierIntegrationSettings['environment'],
                }))
              }
            />
          </div>

          <div className="flex items-end">
            <button
              type="button"
              onClick={handleTestConnection}
              disabled={testing}
              className="flex items-center gap-2 border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 font-semibold py-2 px-6 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {testing ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
              {testing ? 'Testing...' : 'Test Connection'}
            </button>
          </div>
        </div>

        {/* Last test result */}
        {(lastTestLabel || form.lastTestError) && (
          <div className="mt-4 text-xs">
            {form.lastTestError ? (
              <p className="text-red-600">
                Last test failed{lastTestLabel ? ` (${lastTestLabel})` : ''}: {form.lastTestError}
              </p>
            ) : (
              <p className="text-slate-500">Last tested successfully: {lastTestLabel}</p>
            )}
          </div>
        )}
      </div>

      {/* Pickup & Origin */}
      <div className="bg-white rounded-xl border border-slate-200 p-6">
        <h3 className="font-semibold text-slate-900 mb-4">Pickup &amp; Origin</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-slate-700 mb-2">Pickup location name</label>
            <input
              type="text"
              value={form.pickupName}
              onChange={(e) => setForm((f) => ({ ...f, pickupName: e.target.value }))}
              className={fieldCls}
              placeholder="e.g. M2C Warehouse"
            />
            <p className="text-xs text-slate-500 mt-1">
              The exact registered pickup location name in the Delhivery panel.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Origin pincode</label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={form.originPincode}
              onChange={(e) =>
                setForm((f) => ({ ...f, originPincode: e.target.value.replace(/\D/g, '').slice(0, 6) }))
              }
              className={fieldCls}
              placeholder="6-digit pincode"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Client name</label>
            <input
              type="text"
              value={form.clientName}
              onChange={(e) => setForm((f) => ({ ...f, clientName: e.target.value }))}
              className={fieldCls}
              placeholder="Registered client name"
            />
          </div>
        </div>
      </div>

      {/* Register pickup location with Delhivery */}
      <div className="bg-white rounded-xl border border-slate-200 p-6">
        <h3 className="font-semibold text-slate-900 mb-1">Register Pickup Location with Delhivery</h3>
        <p className="text-xs text-slate-500 mb-4">
          Delhivery only accepts shipments from a pickup location registered in <strong>its own</strong> system — your internal Hubs don&apos;t count. Register your pickup/warehouse here; on success its name is set as the pickup above and shipments will work. (If it already exists in Delhivery with this exact name, just set the name in Pickup &amp; Origin instead.)
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Pickup name</label>
            <input type="text" value={pickupForm.name} onChange={(e) => setPickupForm((p) => ({ ...p, name: e.target.value }))} className={fieldCls} placeholder="e.g. M2C Warehouse" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Phone</label>
            <input type="text" value={pickupForm.phone} onChange={(e) => setPickupForm((p) => ({ ...p, phone: e.target.value }))} className={fieldCls} placeholder="10-digit phone" />
          </div>
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-slate-700 mb-2">Address</label>
            <input type="text" value={pickupForm.address} onChange={(e) => setPickupForm((p) => ({ ...p, address: e.target.value }))} className={fieldCls} placeholder="Full pickup address" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">City</label>
            <input type="text" value={pickupForm.city} onChange={(e) => setPickupForm((p) => ({ ...p, city: e.target.value }))} className={fieldCls} placeholder="City" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">State</label>
            <input type="text" value={pickupForm.state} onChange={(e) => setPickupForm((p) => ({ ...p, state: e.target.value }))} className={fieldCls} placeholder="State" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Pincode</label>
            <input type="text" inputMode="numeric" maxLength={6} value={pickupForm.pincode} onChange={(e) => setPickupForm((p) => ({ ...p, pincode: e.target.value.replace(/\D/g, '').slice(0, 6) }))} className={fieldCls} placeholder="6-digit pincode" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Email <span className="text-slate-400">(optional)</span></label>
            <input type="email" value={pickupForm.email} onChange={(e) => setPickupForm((p) => ({ ...p, email: e.target.value }))} className={fieldCls} placeholder="pickup@email.com" />
          </div>
        </div>
        <button
          type="button"
          onClick={handleRegisterPickup}
          disabled={registering}
          className="mt-4 inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {registering ? 'Registering…' : 'Register with Delhivery'}
        </button>
      </div>

      {/* Parcel defaults */}
      <div className="bg-white rounded-xl border border-slate-200 p-6">
        <h3 className="font-semibold text-slate-900 mb-1">Parcel defaults</h3>
        <p className="text-xs text-slate-500 mb-4">Used when a product has no dimensions of its own.</p>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-5">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Weight (grams)</label>
            <input
              type="number"
              min={0}
              value={form.defaultWeightGrams}
              onChange={(e) => setNum('defaultWeightGrams', e.target.value)}
              className={fieldCls}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Length (cm)</label>
            <input
              type="number"
              min={0}
              value={form.defaultLengthCm}
              onChange={(e) => setNum('defaultLengthCm', e.target.value)}
              className={fieldCls}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Width (cm)</label>
            <input
              type="number"
              min={0}
              value={form.defaultWidthCm}
              onChange={(e) => setNum('defaultWidthCm', e.target.value)}
              className={fieldCls}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Height (cm)</label>
            <input
              type="number"
              min={0}
              value={form.defaultHeightCm}
              onChange={(e) => setNum('defaultHeightCm', e.target.value)}
              className={fieldCls}
            />
          </div>
        </div>
      </div>

      {/* Activation */}
      <div className="bg-white rounded-xl border border-slate-200 p-6">
        <h3 className="font-semibold text-slate-900 mb-4">Activation</h3>
        <div className="space-y-4">
          {/* Master enable toggle */}
          <div className="flex items-center justify-between rounded-lg border border-slate-200 p-4">
            <div>
              <p className="text-sm font-medium text-slate-800">Enable Delhivery integration</p>
              <p className="text-xs text-slate-500">
                Master switch for the live courier integration.
                {!canEnable && (
                  <span className="text-amber-600">
                    {' '}Add an API token and pickup location name before enabling.
                  </span>
                )}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={form.enabled}
              disabled={!canEnable && !form.enabled}
              onClick={() => setForm((f) => ({ ...f, enabled: !f.enabled }))}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                form.enabled ? 'bg-brand-500' : 'bg-slate-300'
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                  form.enabled ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          {/* Live rates toggle */}
          <div className="flex items-center justify-between rounded-lg border border-slate-200 p-4">
            <div>
              <p className="text-sm font-medium text-slate-800">Use live shipping rates</p>
              <p className="text-xs text-slate-500">Fetch real-time rates from Delhivery at checkout.</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={form.useLiveRates}
              onClick={() => setForm((f) => ({ ...f, useLiveRates: !f.useLiveRates }))}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                form.useLiveRates ? 'bg-brand-500' : 'bg-slate-300'
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                  form.useLiveRates ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          {/* Amber warning shown when enabled */}
          {form.enabled && (
            <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg p-4">
              <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
              <p className="text-xs text-amber-800">
                When enabled, Delhivery auto-creates shipments for India (INR) orders and the manual courier/tracking
                entry is disabled for them. International (.com) orders keep the manual method.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Webhook — real-time status updates */}
      <div className="bg-white rounded-xl border border-slate-200 p-6">
        <h3 className="font-semibold text-slate-900 mb-1">Status webhook (real-time updates)</h3>
        <p className="text-xs text-slate-500 mb-4">
          Register this URL in your Delhivery panel so Delhivery pushes shipment status changes to us — orders then auto-update (Delivered, RTO, Cancelled…). Works only on your deployed (public) URL, not localhost. Until then, the admin &quot;Track&quot; button syncs an order on click.
        </p>
        {form.hasWebhookSecret ? (
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Webhook URL</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={form.webhookUrl || ''}
                  className={`${fieldCls} font-mono text-xs`}
                  placeholder="Set BACKEND_PUBLIC_URL env to show the full URL"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  type="button"
                  onClick={() => { navigator.clipboard?.writeText(form.webhookUrl || form.webhookPath || ''); showSuccessToast('Copied', 'Webhook URL copied'); }}
                  className="shrink-0 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Copy
                </button>
              </div>
              {!form.webhookUrl && (
                <p className="text-xs text-amber-600 mt-1">
                  Path: <span className="font-mono">{form.webhookPath}</span> — prefix it with your deployed backend domain (set the <span className="font-mono">BACKEND_PUBLIC_URL</span> env var to show the full URL here).
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={handleGenerateWebhook}
              disabled={generatingSecret}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {generatingSecret ? 'Rotating…' : 'Rotate secret'}
            </button>
            <p className="text-xs text-slate-400">Rotating invalidates the old URL — re-register the new one in Delhivery.</p>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleGenerateWebhook}
            disabled={generatingSecret}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {generatingSecret ? 'Generating…' : 'Generate webhook URL'}
          </button>
        )}
      </div>

      {/* Pincode serviceability check */}
      <div className="bg-white rounded-xl border border-slate-200 p-6">
        <h3 className="font-semibold text-slate-900 mb-1">Pincode serviceability check</h3>
        <p className="text-xs text-slate-500 mb-4">Check whether Delhivery serves a destination pincode.</p>
        <div className="flex flex-wrap items-start gap-3">
          <div className="relative">
            <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={pincodeQuery}
              onChange={(e) => setPincodeQuery(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className="pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
              placeholder="Destination pincode"
            />
          </div>
          <button
            type="button"
            onClick={handleCheckServiceability}
            disabled={checkingPincode}
            className="flex items-center gap-2 border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 font-semibold py-2 px-6 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {checkingPincode ? <RefreshCw className="h-4 w-4 animate-spin" /> : <MapPin className="h-4 w-4" />}
            {checkingPincode ? 'Checking...' : 'Check'}
          </button>
        </div>

        {serviceability && (
          <div
            className={`mt-4 rounded-lg border p-4 ${
              serviceability.serviceable
                ? 'bg-green-50 border-green-200'
                : 'bg-red-50 border-red-200'
            }`}
          >
            <p
              className={`text-sm font-medium flex items-center gap-1.5 ${
                serviceability.serviceable ? 'text-green-700' : 'text-red-700'
              }`}
            >
              {serviceability.serviceable ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                <XCircle className="h-4 w-4" />
              )}
              {serviceability.serviceable ? 'Serviceable' : 'Not serviceable'}
            </p>
            {serviceability.serviceable && (
              <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-600">
                {(serviceability.city || serviceability.state) && (
                  <span>
                    Location:{' '}
                    <strong>{[serviceability.city, serviceability.state].filter(Boolean).join(', ')}</strong>
                  </span>
                )}
                <span>Prepaid: <strong>{serviceability.prepaid ? 'Yes' : 'No'}</strong></span>
                <span>COD: <strong>{serviceability.cod ? 'Yes' : 'No'}</strong></span>
                <span>Pickup: <strong>{serviceability.pickup ? 'Yes' : 'No'}</strong></span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Save */}
      <div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 bg-brand-500 hover:bg-brand-600 text-white font-semibold py-2 px-6 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}
