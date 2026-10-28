import authRoutes from './auth.js';
import registryRoutes from './registry.js';
import telephonyRoutes from './telephony.js';
import directoryRoutes from './directory.js';
import workspaceRoutes from './workspace.js';
import mediaRoutes from './media.js';
import systemsRoutes from './systems.js';
import softphoneRoutes from './softphone.js';
import voiceRoutes from './voice.js';
import heartbeatRoutes from './heartbeat.js';
import systemRoutes from './system.js';
import payRoutes from './pay.js';
import marketingRoutes from './marketing.js';
import portalRoutes from './portal.js';
import meRoutes from './me.js';
import carrierRoutes from './carriers.js';
import setupRoutes from './setup.js';
import onboardingRoutes from './onboarding.js';
import secureRoutes from './secure.js';

/** Everything under /api. */
export async function registerRoutes(app) {
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(registryRoutes);
  await app.register(telephonyRoutes);
  await app.register(directoryRoutes);
  await app.register(workspaceRoutes);
  await app.register(mediaRoutes);
  await app.register(systemsRoutes);
  await app.register(softphoneRoutes);
  // Voiceprints: enrollment, checks and the gate a softphone session spends.
  await app.register(voiceRoutes);
  // Devices authenticate themselves, so this sits outside the session surface.
  await app.register(heartbeatRoutes);
  await app.register(systemRoutes);
  // Public invoice payment links and Stripe's webhook: no session, by design.
  await app.register(payRoutes);
  // Outbound campaigns over the voice agents, with a graded report.
  await app.register(marketingRoutes);
  // The public pricing page, subscriptions and the plan/feature admin.
  await app.register(portalRoutes);
  // A customer's own surface: their line, plan and invoices, and nothing else.
  await app.register(meRoutes);
  // Buying and releasing numbers at the carrier, and what they cost.
  await app.register(carrierRoutes);
  // First run: the line, number and registration that make a fresh install
  // able to place a call at all.
  await app.register(setupRoutes);
  // The required first login: terms, details, a proved address and phone, and a
  // line. Staff and customers both walk through it.
  await app.register(onboardingRoutes);
  // Internal secure messaging: a channel with no carrier and no per-message
  // cost, sealed at rest.
  await app.register(secureRoutes);
}

export default registerRoutes;
