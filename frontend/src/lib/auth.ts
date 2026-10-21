// Authentication utilities for admin dashboard

export interface AdminUser {
  id: string
  email: string
  name: string
  role: string
  roleName?: string
  permissions?: string[]
  image?: string
  isVerified?: boolean
  phoneNumber?: string
  address?: string
  city?: string
  state?: string
  zipCode?: string
  country?: string
  dateOfBirth?: string
  currency?: string
  companyName?: string
  gstNumber?: string
  onboardingCompleted?: boolean
}

export interface AuthTokens {
  token: string
  user: AdminUser
}

// RBAC helper
export function hasPermission(permission: string | string[]): boolean {
  try {
    const auth = getStoredAuth()
    if (!auth || !auth.user) return false

    // Super Admin bypass — case/spacing insensitive so a renamed role won't break it
    if (auth.user.roleName && auth.user.roleName.toLowerCase().trim() === 'super admin') {
      return true
    }

    if (!auth.user.permissions) return false

    const permissionsToCheck = Array.isArray(permission) ? permission : [permission]
    return permissionsToCheck.some(p => auth.user.permissions?.includes(p))
  } catch {
    return false
  }
}

// Storage keys
const TOKEN_KEY = 'adminToken'
const USER_KEY = 'adminUser'

// Get stored authentication data
export function getStoredAuth(): AuthTokens | null {
  try {
    // Ensure we're in browser environment
    if (typeof window === 'undefined') {
      return null
    }

    // Check sessionStorage first, then localStorage
    let token = sessionStorage.getItem(TOKEN_KEY)
    let userStr = sessionStorage.getItem(USER_KEY)

    if (!token || !userStr) {
      token = localStorage.getItem(TOKEN_KEY)
      userStr = localStorage.getItem(USER_KEY)
    }

    if (!token || !userStr) {
      return null
    }

    const user = JSON.parse(userStr)

    // Validate user object has required properties
    if (!user || !user.id || !user.role) {
      console.warn('Invalid user data found in storage')
      return null
    }

    return { token, user }
  } catch (error) {
    console.error('Error getting stored auth:', error)
    return null
  }
}

// Store authentication data
export function storeAuth(token: string, user: AdminUser, remember: boolean = false): void {
  try {
    if (remember) {
      localStorage.setItem(TOKEN_KEY, token)
      localStorage.setItem(USER_KEY, JSON.stringify(user))
    } else {
      sessionStorage.setItem(TOKEN_KEY, token)
      sessionStorage.setItem(USER_KEY, JSON.stringify(user))
    }
  } catch (error) {
    console.error('Error storing auth:', error)
  }
}

// Clear authentication data
export function clearAuth(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY)
    sessionStorage.removeItem(USER_KEY)
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
  } catch (error) {
    console.error('Error clearing auth:', error)
  }
}

// Check if user is authenticated
export function isAuthenticated(): boolean {
  try {
    const auth = getStoredAuth()
    if (!auth || !auth.user || !auth.user.role) {
      return false
    }
    return auth.user.role.toLowerCase() === 'admin'
  } catch (error) {
    console.error('Error in isAuthenticated:', error)
    return false
  }
}

// Get authorization header for API calls
export function getAuthHeader(): Record<string, string> {
  const auth = getStoredAuth()
  if (!auth) {
    return {}
  }

  return {
    'Authorization': `Bearer ${auth.token}`
  }
}

// API call wrapper with authentication
export async function authenticatedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const authHeaders = getAuthHeader()

  const response = await fetch(url, {
    ...options,
    credentials: 'include', // Include httpOnly cookies
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
      ...options.headers,
    },
  })

  // If unauthorized, clear auth and redirect to login (but not for login attempts)
  if (response.status === 401) {
    const isLoginAttempt = url.includes('/auth/login') ||
      url.includes('/auth/admin/login') ||
      url.includes('/auth/vendor') ||
      url.includes('/vendors/login');

    if (!isLoginAttempt) {
      clearAuth()
      window.location.href = '/admin/login'
    }
  }

  return response
}

import axiosInstance, { createAdminAxiosInstance } from './axios'

// Result of checking the stored admin session against the backend.
//  - 'valid'       the server confirmed a live admin session
//  - 'invalid'     the server rejected it (no/expired/revoked token, or not an
//                  admin) — caller must clear and send the user to login
//  - 'unreachable' the backend couldn't be reached (network/5xx); we can't prove
//                  the session is invalid, so a plausibly-live session is kept
export type AdminSessionResult =
  | { status: 'valid'; user: AdminUser }
  | { status: 'invalid' }
  | { status: 'unreachable' }

// Verify the stored admin session with the backend.
//
// A token sitting in localStorage is NOT proof of a live session — it can be
// stale, expired, or revoked. Presence-only checks let a leftover token drop
// anyone straight into the dashboard with no credentials. This confirms with
// the server (GET /auth/admin/me) and clears auth on a definitive rejection.
//
// Uses a bare admin axios instance so the global 401 interceptor's own
// clear-and-redirect doesn't race the caller's handling.
export async function verifyAdminSession(): Promise<AdminSessionResult> {
  const auth = getStoredAuth()
  if (!auth || !auth.user || auth.user.role?.toLowerCase() !== 'admin') {
    return { status: 'invalid' }
  }

  try {
    const client = createAdminAxiosInstance()
    const res = await client.get('/auth/admin/me')
    const user = res.data?.data

    if (!user || !user.id || String(user.role).toLowerCase() !== 'admin') {
      clearAuth()
      return { status: 'invalid' }
    }

    return { status: 'valid', user: user as AdminUser }
  } catch (error: any) {
    const code = error?.response?.status
    if (code === 401 || code === 403 || code === 404) {
      clearAuth()
      return { status: 'invalid' }
    }
    // Network failure or server error — can't prove the session is invalid, so
    // don't destroy it. Fail open only here.
    return { status: 'unreachable' }
  }
}

// Logout function
export async function logout(): Promise<void> {
  try {
    const auth = getStoredAuth()
    if (auth) {
      // Call backend logout endpoint with credentials for httpOnly cookies
      await axiosInstance.post('/auth/logout', {}, {
        withCredentials: true, // Include httpOnly cookies
      }).catch(() => {
        // Ignore errors, just clear local storage
      })
    }
  } finally {
    clearAuth()
    // Import toast function dynamically to avoid SSR issues
    if (typeof window !== 'undefined') {
      const { showSuccessToast } = await import('@/lib/toast-utils')
      showSuccessToast('Logged Out', 'You have been successfully logged out.')

      // Small delay to show the toast before redirect
      setTimeout(() => {
        window.location.href = '/admin/login'
      }, 1000)
    }
  }
}