import { notFound } from "next/navigation";
import { IntlProvider } from "@/components/providers/intl-provider";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { CalendarAlertProvider } from "@/components/providers/calendar-alert-provider";
import { EmbeddedBridgeProvider } from "@/components/providers/embedded-bridge-provider";
import { RateLimitToastProvider } from "@/components/providers/rate-limit-toast-provider";
import { TourProvider } from "@/components/tour/tour-provider";
import { locales } from "@/i18n/routing";

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  if (!(locales as readonly string[]).includes(locale)) notFound();

  return (
    <IntlProvider locale={locale}>
      <ThemeProvider>
        <CalendarAlertProvider>
          <RateLimitToastProvider>
            <EmbeddedBridgeProvider>
              <TourProvider>
                {children}
              </TourProvider>
            </EmbeddedBridgeProvider>
          </RateLimitToastProvider>
        </CalendarAlertProvider>
      </ThemeProvider>
    </IntlProvider>
  );
}
