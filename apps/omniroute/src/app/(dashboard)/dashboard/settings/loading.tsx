"use client";

export default function SettingsLoading() {
  return (
    <div className="space-y-6 animate-pulse p-6">
      <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-36" />
      <div className="space-y-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="space-y-2">
            <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-24" />
            <div className="h-10 bg-gray-200 dark:bg-gray-700 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
