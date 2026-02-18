"use client";

export default function AnalyticsLoading() {
  return (
    <div className="space-y-6 animate-pulse p-6">
      <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-40" />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-24 bg-gray-200 dark:bg-gray-700 rounded-lg" />
        ))}
      </div>
      <div className="h-64 bg-gray-200 dark:bg-gray-700 rounded-lg" />
    </div>
  );
}
