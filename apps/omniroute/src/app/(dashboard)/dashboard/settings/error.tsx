"use client";

export default function SettingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] p-6">
      <div className="text-center space-y-4">
        <h2 className="text-xl font-semibold text-red-600 dark:text-red-400">
          Failed to load settings
        </h2>
        <p className="text-gray-600 dark:text-gray-400 max-w-md">
          {error.message || "An unexpected error occurred while loading settings."}
        </p>
        <button
          onClick={reset}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          Try Again
        </button>
      </div>
    </div>
  );
}
