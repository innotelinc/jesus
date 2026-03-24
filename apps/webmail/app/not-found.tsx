"use client";

import { useEffect } from "react";
import { useAuthStore } from "@/stores/auth-store";

export default function NotFound() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  useEffect(() => {
    if (!isAuthenticated) {
      // Don't redirect admin routes to the webmail login page
      const isAdminRoute = window.location.pathname === '/admin' || window.location.pathname.startsWith('/admin/');
      if (!isAdminRoute) {
        window.location.href = "/login";
      }
    }
  }, [isAuthenticated]);

  if (!isAuthenticated) {
    // Allow admin routes to render the 404 without redirecting
    const isAdmin = typeof window !== 'undefined' &&
      (window.location.pathname === '/admin' || window.location.pathname.startsWith('/admin/'));
    if (!isAdmin) return null;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center max-w-md px-4">
        <h1 className="text-4xl font-bold text-foreground mb-2">404</h1>
        <p className="text-muted-foreground mb-6">This page could not be found.</p>
        <a
          href="/"
          className="inline-flex items-center px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity"
        >
          Go home
        </a>
      </div>
    </div>
  );
}
