'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { verifyAdminSession } from '@/lib/auth'
import LoadingSpinner from '@/components/UI/LoadingSpinner'

interface ProtectedRouteProps {
  children: React.ReactNode
}

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const [isLoading, setIsLoading] = useState(true)
  const [isAuthorized, setIsAuthorized] = useState(false)
  const router = useRouter()

  useEffect(() => {
    const checkAuth = async () => {
      try {
        // Validate the session with the backend — a token existing in storage
        // is not proof it's still valid. Only a definitive rejection blocks;
        // an unreachable backend keeps a plausibly-live session (fails open).
        const result = await verifyAdminSession()

        if (result.status === 'invalid') {
          router.replace('/admin/login')
          return
        }

        setIsAuthorized(true)
      } catch (error) {
        console.error('ProtectedRoute: Auth check error:', error)
        router.replace('/admin/login')
      } finally {
        setIsLoading(false)
      }
    }

    // Only run in browser environment
    if (typeof window !== 'undefined') {
      checkAuth()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Show loading for a bit longer to ensure proper auth check
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center">
          <LoadingSpinner />
          <p className="mt-4 text-slate-600">Verifying authentication...</p>
        </div>
      </div>
    )
  }

  if (!isAuthorized) {
    return null // Will redirect to login
  }

  return <>{children}</>
}