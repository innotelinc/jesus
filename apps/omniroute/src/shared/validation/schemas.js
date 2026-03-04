"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dbBackupRestoreSchema =
  exports.testComboSchema =
  exports.updateComboSchema =
  exports.cloudSyncActionSchema =
  exports.cloudModelAliasUpdateSchema =
  exports.cloudResolveAliasSchema =
  exports.cloudCredentialUpdateSchema =
  exports.kiroSocialExchangeSchema =
  exports.kiroImportSchema =
  exports.cursorImportSchema =
  exports.oauthPollSchema =
  exports.oauthExchangeSchema =
  exports.translatorTranslateSchema =
  exports.translatorSendSchema =
  exports.translatorSaveSchema =
  exports.translatorDetectSchema =
  exports.testProxySchema =
  exports.updateProxyConfigSchema =
  exports.removeModelAliasSchema =
  exports.addModelAliasSchema =
  exports.updateModelAliasesSchema =
  exports.updateIpFilterSchema =
  exports.updateThinkingBudgetSchema =
  exports.updateSystemPromptSchema =
  exports.updateRequireLoginSchema =
  exports.updateComboDefaultsSchema =
  exports.resetStatsActionSchema =
  exports.jsonObjectSchema =
  exports.updateResilienceSchema =
  exports.toggleRateLimitSchema =
  exports.updatePricingSchema =
  exports.providerModelMutationSchema =
  exports.clearModelAvailabilitySchema =
  exports.updateModelAliasSchema =
  exports.removeFallbackSchema =
  exports.registerFallbackSchema =
  exports.policyActionSchema =
  exports.setBudgetSchema =
  exports.v1CountTokensSchema =
  exports.providerChatCompletionSchema =
  exports.v1RerankSchema =
  exports.v1ModerationSchema =
  exports.v1AudioSpeechSchema =
  exports.v1ImageGenerationSchema =
  exports.v1EmbeddingsSchema =
  exports.loginSchema =
  exports.updateSettingsSchema =
  exports.createComboSchema =
  exports.createKeySchema =
  exports.createProviderSchema =
    void 0;
exports.guideSettingsSaveSchema =
  exports.codexProfileIdSchema =
  exports.codexProfileNameSchema =
  exports.cliModelConfigSchema =
  exports.cliSettingsEnvSchema =
  exports.cliBackupMutationSchema =
  exports.cliMitmAliasUpdateSchema =
  exports.cliMitmStopSchema =
  exports.cliMitmStartSchema =
  exports.v1betaGeminiGenerateSchema =
  exports.validateProviderApiKeySchema =
  exports.providersBatchTestSchema =
  exports.updateProviderConnectionSchema =
  exports.providerNodeValidateSchema =
  exports.updateProviderNodeSchema =
  exports.createProviderNodeSchema =
  exports.updateKeyPermissionsSchema =
  exports.evalRunSuiteSchema =
    void 0;
exports.validateBody = validateBody;
var zod_1 = require("zod");
// ──── Provider Schemas ────
exports.createProviderSchema = zod_1.z.object({
  provider: zod_1.z.string().min(1).max(100),
  apiKey: zod_1.z.string().min(1).max(10000),
  name: zod_1.z.string().min(1).max(200),
  priority: zod_1.z.number().int().min(1).max(100).optional(),
  globalPriority: zod_1.z.number().int().min(1).max(100).nullable().optional(),
  defaultModel: zod_1.z.string().max(200).nullable().optional(),
  testStatus: zod_1.z.string().max(50).optional(),
});
// ──── API Key Schemas ────
exports.createKeySchema = zod_1.z.object({
  name: zod_1.z.string().min(1, "Name is required").max(200),
});
// ──── Combo Schemas ────
// A model entry can be a plain string (legacy) or an object with weight
var comboModelEntry = zod_1.z.union([
  zod_1.z.string(),
  zod_1.z.object({
    model: zod_1.z.string().min(1),
    weight: zod_1.z.number().min(0).max(100).default(0),
  }),
]);
// Per-combo config overrides
var comboConfigSchema = zod_1.z
  .object({
    maxRetries: zod_1.z.number().int().min(0).max(10).optional(),
    retryDelayMs: zod_1.z.number().int().min(0).max(60000).optional(),
    timeoutMs: zod_1.z.number().int().min(1000).max(600000).optional(),
    healthCheckEnabled: zod_1.z.boolean().optional(),
  })
  .optional();
var comboStrategySchema = zod_1.z.enum([
  "priority",
  "weighted",
  "round-robin",
  "random",
  "least-used",
  "cost-optimized",
]);
var comboRuntimeConfigSchema = zod_1.z
  .object({
    strategy: comboStrategySchema.optional(),
    maxRetries: zod_1.z.coerce.number().int().min(0).max(10).optional(),
    retryDelayMs: zod_1.z.coerce.number().int().min(0).max(60000).optional(),
    timeoutMs: zod_1.z.coerce.number().int().min(1000).max(600000).optional(),
    concurrencyPerModel: zod_1.z.coerce.number().int().min(1).max(20).optional(),
    queueTimeoutMs: zod_1.z.coerce.number().int().min(1000).max(120000).optional(),
    healthCheckEnabled: zod_1.z.boolean().optional(),
    healthCheckTimeoutMs: zod_1.z.coerce.number().int().min(100).max(30000).optional(),
    maxComboDepth: zod_1.z.coerce.number().int().min(1).max(10).optional(),
    trackMetrics: zod_1.z.boolean().optional(),
  })
  .strict();
exports.createComboSchema = zod_1.z.object({
  name: zod_1.z
    .string()
    .min(1, "Name is required")
    .max(100)
    .regex(/^[a-zA-Z0-9_/.-]+$/, "Name can only contain letters, numbers, -, _, / and ."),
  models: zod_1.z.array(comboModelEntry).optional().default([]),
  strategy: comboStrategySchema.optional().default("priority"),
  config: comboConfigSchema,
});
// ──── Settings Schemas ────
// FASE-01: Removed .passthrough() — only explicitly listed fields are accepted
exports.updateSettingsSchema = zod_1.z.object({
  newPassword: zod_1.z.string().min(1).max(200).optional(),
  currentPassword: zod_1.z.string().max(200).optional(),
  theme: zod_1.z.string().max(50).optional(),
  language: zod_1.z.string().max(10).optional(),
  requireLogin: zod_1.z.boolean().optional(),
  enableRequestLogs: zod_1.z.boolean().optional(),
  enableSocks5Proxy: zod_1.z.boolean().optional(),
  instanceName: zod_1.z.string().max(100).optional(),
  corsOrigins: zod_1.z.string().max(500).optional(),
  logRetentionDays: zod_1.z.number().int().min(1).max(365).optional(),
  cloudUrl: zod_1.z.string().max(500).optional(),
  baseUrl: zod_1.z.string().max(500).optional(),
  setupComplete: zod_1.z.boolean().optional(),
  requireAuthForModels: zod_1.z.boolean().optional(),
  blockedProviders: zod_1.z.array(zod_1.z.string().max(100)).optional(),
  hideHealthCheckLogs: zod_1.z.boolean().optional(),
  // Routing settings (#134)
  fallbackStrategy: zod_1.z
    .enum(["fill-first", "round-robin", "p2c", "random", "least-used", "cost-optimized"])
    .optional(),
  wildcardAliases: zod_1.z
    .array(zod_1.z.object({ pattern: zod_1.z.string(), target: zod_1.z.string() }))
    .optional(),
  stickyRoundRobinLimit: zod_1.z.number().int().min(0).max(1000).optional(),
});
// ──── Auth Schemas ────
exports.loginSchema = zod_1.z.object({
  password: zod_1.z.string().min(1, "Password is required").max(200),
});
// ──── API Route Payload Schemas (T06) ────
var modelIdSchema = zod_1.z.string().trim().min(1, "Model is required").max(200);
var nonEmptyStringSchema = zod_1.z.string().trim().min(1, "Field is required");
var embeddingTokenArraySchema = zod_1.z
  .array(zod_1.z.number().int().min(0))
  .min(1, "input token array must contain at least one item");
var embeddingInputSchema = zod_1.z.union([
  nonEmptyStringSchema,
  zod_1.z.array(nonEmptyStringSchema).min(1, "input must contain at least one item"),
  embeddingTokenArraySchema,
  zod_1.z.array(embeddingTokenArraySchema).min(1, "input must contain at least one item"),
]);
var chatMessageSchema = zod_1.z
  .object({
    role: zod_1.z.string().trim().min(1, "messages[].role is required"),
    content: zod_1.z
      .union([nonEmptyStringSchema, zod_1.z.array(zod_1.z.unknown()).min(1), zod_1.z.null()])
      .optional(),
  })
  .catchall(zod_1.z.unknown());
var countTokensMessageSchema = zod_1.z
  .object({
    content: zod_1.z.union([
      nonEmptyStringSchema,
      zod_1.z
        .array(
          zod_1.z
            .object({
              type: zod_1.z.string().optional(),
              text: zod_1.z.string().optional(),
            })
            .catchall(zod_1.z.unknown())
        )
        .min(1, "messages[].content must contain at least one item"),
    ]),
  })
  .catchall(zod_1.z.unknown());
exports.v1EmbeddingsSchema = zod_1.z
  .object({
    model: modelIdSchema,
    input: embeddingInputSchema,
    dimensions: zod_1.z.coerce.number().int().positive().optional(),
    encoding_format: zod_1.z.enum(["float", "base64"]).optional(),
  })
  .catchall(zod_1.z.unknown());
exports.v1ImageGenerationSchema = zod_1.z
  .object({
    model: modelIdSchema,
    prompt: nonEmptyStringSchema,
  })
  .catchall(zod_1.z.unknown());
exports.v1AudioSpeechSchema = zod_1.z
  .object({
    model: modelIdSchema,
    input: nonEmptyStringSchema,
  })
  .catchall(zod_1.z.unknown());
exports.v1ModerationSchema = zod_1.z
  .object({
    model: modelIdSchema.optional(),
    input: zod_1.z.unknown().refine(function (value) {
      if (value === undefined || value === null) return false;
      if (typeof value === "string") return value.trim().length > 0;
      if (Array.isArray(value)) return value.length > 0;
      return true;
    }, "Input is required"),
  })
  .catchall(zod_1.z.unknown());
exports.v1RerankSchema = zod_1.z
  .object({
    model: modelIdSchema,
    query: nonEmptyStringSchema,
    documents: zod_1.z.array(zod_1.z.unknown()).min(1, "documents must contain at least one item"),
  })
  .catchall(zod_1.z.unknown());
exports.providerChatCompletionSchema = zod_1.z
  .object({
    model: modelIdSchema,
    messages: zod_1.z.array(chatMessageSchema).min(1).optional(),
    input: zod_1.z
      .union([nonEmptyStringSchema, zod_1.z.array(zod_1.z.unknown()).min(1)])
      .optional(),
    prompt: nonEmptyStringSchema.optional(),
  })
  .catchall(zod_1.z.unknown())
  .superRefine(function (value, ctx) {
    if (value.messages === undefined && value.input === undefined && value.prompt === undefined) {
      ctx.addIssue({
        code: zod_1.z.ZodIssueCode.custom,
        message: "messages, input or prompt is required",
        path: [],
      });
    }
  });
exports.v1CountTokensSchema = zod_1.z
  .object({
    messages: zod_1.z
      .array(countTokensMessageSchema)
      .min(1, "messages must contain at least one item"),
  })
  .catchall(zod_1.z.unknown());
exports.setBudgetSchema = zod_1.z.object({
  apiKeyId: zod_1.z.string().trim().min(1, "apiKeyId is required"),
  dailyLimitUsd: zod_1.z.coerce.number().positive("dailyLimitUsd must be greater than zero"),
  monthlyLimitUsd: zod_1.z.coerce
    .number()
    .positive("monthlyLimitUsd must be greater than zero")
    .optional(),
  warningThreshold: zod_1.z.coerce.number().min(0).max(1).optional(),
});
exports.policyActionSchema = zod_1.z
  .object({
    action: zod_1.z.enum(["unlock"]),
    identifier: zod_1.z.string().trim().min(1).optional(),
  })
  .superRefine(function (value, ctx) {
    if (value.action === "unlock" && !value.identifier) {
      ctx.addIssue({
        code: zod_1.z.ZodIssueCode.custom,
        message: "identifier is required for unlock action",
        path: ["identifier"],
      });
    }
  });
var fallbackChainEntrySchema = zod_1.z
  .object({
    provider: zod_1.z.string().trim().min(1, "provider is required"),
    priority: zod_1.z.number().int().min(1).max(100).optional(),
    enabled: zod_1.z.boolean().optional(),
  })
  .catchall(zod_1.z.unknown());
exports.registerFallbackSchema = zod_1.z.object({
  model: modelIdSchema,
  chain: zod_1.z.array(fallbackChainEntrySchema).min(1, "chain must contain at least one provider"),
});
exports.removeFallbackSchema = zod_1.z.object({
  model: modelIdSchema,
});
exports.updateModelAliasSchema = zod_1.z.object({
  model: modelIdSchema,
  alias: zod_1.z.string().trim().min(1, "Alias is required").max(200),
});
exports.clearModelAvailabilitySchema = zod_1.z.object({
  provider: zod_1.z.string().trim().min(1, "provider is required").max(120),
  model: modelIdSchema,
});
exports.providerModelMutationSchema = zod_1.z.object({
  provider: zod_1.z.string().trim().min(1, "provider is required").max(120),
  modelId: zod_1.z.string().trim().min(1, "modelId is required").max(240),
  modelName: zod_1.z.string().trim().max(240).optional(),
  source: zod_1.z.string().trim().max(80).optional(),
});
var pricingFieldsSchema = zod_1.z
  .object({
    input: zod_1.z.number().min(0).optional(),
    output: zod_1.z.number().min(0).optional(),
    cached: zod_1.z.number().min(0).optional(),
    reasoning: zod_1.z.number().min(0).optional(),
    cache_creation: zod_1.z.number().min(0).optional(),
  })
  .strict();
exports.updatePricingSchema = zod_1.z.record(
  zod_1.z.string().trim().min(1),
  zod_1.z.record(zod_1.z.string().trim().min(1), pricingFieldsSchema)
);
exports.toggleRateLimitSchema = zod_1.z.object({
  connectionId: zod_1.z.string().trim().min(1, "connectionId is required"),
  enabled: zod_1.z.boolean(),
});
var resilienceProfileSchema = zod_1.z.object({
  transientCooldown: zod_1.z.number().min(0),
  rateLimitCooldown: zod_1.z.number().min(0),
  maxBackoffLevel: zod_1.z.number().int().min(0),
  circuitBreakerThreshold: zod_1.z.number().int().min(0),
  circuitBreakerReset: zod_1.z.number().min(0),
});
var resilienceDefaultsSchema = zod_1.z
  .object({
    requestsPerMinute: zod_1.z.number().int().min(1).optional(),
    minTimeBetweenRequests: zod_1.z.number().int().min(1).optional(),
    concurrentRequests: zod_1.z.number().int().min(1).optional(),
  })
  .strict();
exports.updateResilienceSchema = zod_1.z
  .object({
    profiles: zod_1.z
      .object({
        oauth: resilienceProfileSchema.optional(),
        apikey: resilienceProfileSchema.optional(),
      })
      .strict()
      .optional(),
    defaults: resilienceDefaultsSchema.optional(),
  })
  .superRefine(function (value, ctx) {
    if (!value.profiles && !value.defaults) {
      ctx.addIssue({
        code: zod_1.z.ZodIssueCode.custom,
        message: "Must provide profiles or defaults",
        path: [],
      });
    }
  });
exports.jsonObjectSchema = zod_1.z.record(zod_1.z.string(), zod_1.z.unknown());
exports.resetStatsActionSchema = zod_1.z.object({
  action: zod_1.z.literal("reset-stats"),
});
exports.updateComboDefaultsSchema = zod_1.z
  .object({
    comboDefaults: comboRuntimeConfigSchema.optional(),
    providerOverrides: zod_1.z
      .record(zod_1.z.string().trim().min(1), comboRuntimeConfigSchema)
      .optional(),
  })
  .superRefine(function (value, ctx) {
    if (!value.comboDefaults && !value.providerOverrides) {
      ctx.addIssue({
        code: zod_1.z.ZodIssueCode.custom,
        message: "Nothing to update",
        path: [],
      });
    }
  });
exports.updateRequireLoginSchema = zod_1.z
  .object({
    requireLogin: zod_1.z.boolean().optional(),
    password: zod_1.z.string().min(4, "Password must be at least 4 characters").optional(),
  })
  .superRefine(function (value, ctx) {
    if (value.requireLogin === undefined && !value.password) {
      ctx.addIssue({
        code: zod_1.z.ZodIssueCode.custom,
        message: "No valid fields to update",
        path: [],
      });
    }
  });
exports.updateSystemPromptSchema = zod_1.z
  .object({
    prompt: zod_1.z.string().max(50000).optional(),
    enabled: zod_1.z.boolean().optional(),
  })
  .strict()
  .superRefine(function (value, ctx) {
    if (value.prompt === undefined && value.enabled === undefined) {
      ctx.addIssue({
        code: zod_1.z.ZodIssueCode.custom,
        message: "No valid fields to update",
        path: [],
      });
    }
  });
exports.updateThinkingBudgetSchema = zod_1.z
  .object({
    mode: zod_1.z.enum(["passthrough", "auto", "custom", "adaptive"]).optional(),
    customBudget: zod_1.z.coerce.number().int().min(0).max(131072).optional(),
    effortLevel: zod_1.z.enum(["none", "low", "medium", "high"]).optional(),
    baseBudget: zod_1.z.coerce.number().int().min(0).max(131072).optional(),
    complexityMultiplier: zod_1.z.coerce.number().min(0).optional(),
  })
  .strict()
  .superRefine(function (value, ctx) {
    if (
      value.mode === undefined &&
      value.customBudget === undefined &&
      value.effortLevel === undefined &&
      value.baseBudget === undefined &&
      value.complexityMultiplier === undefined
    ) {
      ctx.addIssue({
        code: zod_1.z.ZodIssueCode.custom,
        message: "No valid fields to update",
        path: [],
      });
    }
  });
var ipFilterModeSchema = zod_1.z.enum(["blacklist", "whitelist"]);
var tempBanSchema = zod_1.z.object({
  ip: zod_1.z.string().trim().min(1),
  durationMs: zod_1.z.coerce.number().int().min(1).optional(),
  reason: zod_1.z.string().max(200).optional(),
});
exports.updateIpFilterSchema = zod_1.z
  .object({
    enabled: zod_1.z.boolean().optional(),
    mode: ipFilterModeSchema.optional(),
    blacklist: zod_1.z.array(zod_1.z.string()).optional(),
    whitelist: zod_1.z.array(zod_1.z.string()).optional(),
    addBlacklist: zod_1.z.string().optional(),
    removeBlacklist: zod_1.z.string().optional(),
    addWhitelist: zod_1.z.string().optional(),
    removeWhitelist: zod_1.z.string().optional(),
    tempBan: tempBanSchema.optional(),
    removeBan: zod_1.z.string().optional(),
  })
  .strict()
  .superRefine(function (value, ctx) {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({
        code: zod_1.z.ZodIssueCode.custom,
        message: "No valid fields to update",
        path: [],
      });
    }
  });
exports.updateModelAliasesSchema = zod_1.z.object({
  aliases: zod_1.z.record(zod_1.z.string().trim().min(1), zod_1.z.string().trim().min(1)),
});
exports.addModelAliasSchema = zod_1.z.object({
  from: zod_1.z.string().trim().min(1),
  to: zod_1.z.string().trim().min(1),
});
exports.removeModelAliasSchema = zod_1.z.object({
  from: zod_1.z.string().trim().min(1),
});
var proxyConfigSchema = zod_1.z
  .object({
    type: zod_1.z
      .preprocess(
        function (value) {
          return typeof value === "string" ? value.trim().toLowerCase() : value;
        },
        zod_1.z.enum(["http", "https", "socks5"])
      )
      .optional(),
    host: zod_1.z.string().trim().min(1).optional(),
    port: zod_1.z.coerce.number().int().min(1).max(65535).optional(),
    username: zod_1.z.string().optional(),
    password: zod_1.z.string().optional(),
  })
  .strict();
exports.updateProxyConfigSchema = zod_1.z
  .object({
    proxy: proxyConfigSchema.nullable().optional(),
    global: proxyConfigSchema.nullable().optional(),
    providers: zod_1.z
      .record(zod_1.z.string().trim().min(1), proxyConfigSchema.nullable())
      .optional(),
    combos: zod_1.z.record(zod_1.z.string().trim().min(1), proxyConfigSchema.nullable()).optional(),
    keys: zod_1.z.record(zod_1.z.string().trim().min(1), proxyConfigSchema.nullable()).optional(),
    level: zod_1.z.enum(["global", "provider", "combo", "key"]).optional(),
    id: zod_1.z.string().optional(),
  })
  .strict()
  .superRefine(function (value, ctx) {
    var _a;
    var hasPayload =
      value.proxy !== undefined ||
      value.global !== undefined ||
      value.providers !== undefined ||
      value.combos !== undefined ||
      value.keys !== undefined ||
      value.level !== undefined;
    if (!hasPayload) {
      ctx.addIssue({
        code: zod_1.z.ZodIssueCode.custom,
        message: "No valid fields to update",
        path: [],
      });
    }
    if (value.level !== undefined && value.proxy === undefined) {
      ctx.addIssue({
        code: zod_1.z.ZodIssueCode.custom,
        message: "proxy is required when level is provided",
        path: ["proxy"],
      });
    }
    if (
      value.level &&
      value.level !== "global" &&
      !((_a = value.id) === null || _a === void 0 ? void 0 : _a.trim())
    ) {
      ctx.addIssue({
        code: zod_1.z.ZodIssueCode.custom,
        message: "id is required for provider/combo/key level updates",
        path: ["id"],
      });
    }
  });
exports.testProxySchema = zod_1.z.object({
  proxy: zod_1.z.object({
    type: zod_1.z.string().optional(),
    host: zod_1.z.string().trim().min(1, "proxy.host is required"),
    port: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]),
    username: zod_1.z.string().optional(),
    password: zod_1.z.string().optional(),
  }),
});
var jsonRecordSchema = zod_1.z.record(zod_1.z.string(), zod_1.z.unknown());
var nonEmptyJsonRecordSchema = jsonRecordSchema.refine(function (value) {
  return Object.keys(value).length > 0;
}, "Body must be a non-empty object");
var translatorLogFileSchema = zod_1.z.enum([
  "1_req_client.json",
  "2_req_source.json",
  "3_req_openai.json",
  "4_req_target.json",
  "5_res_provider.txt",
]);
exports.translatorDetectSchema = zod_1.z.object({
  body: nonEmptyJsonRecordSchema,
});
exports.translatorSaveSchema = zod_1.z.object({
  file: translatorLogFileSchema,
  content: zod_1.z.string().min(1, "Content is required").max(1000000, "Content is too large"),
});
exports.translatorSendSchema = zod_1.z.object({
  provider: zod_1.z.string().trim().min(1, "Provider is required"),
  body: nonEmptyJsonRecordSchema,
});
exports.translatorTranslateSchema = zod_1.z
  .object({
    step: zod_1.z.union([zod_1.z.number().int().min(1).max(4), zod_1.z.literal("direct")]),
    provider: zod_1.z.string().trim().min(1).optional(),
    body: nonEmptyJsonRecordSchema,
    sourceFormat: zod_1.z.string().optional(),
    targetFormat: zod_1.z.string().optional(),
  })
  .superRefine(function (value, ctx) {
    if (value.step !== "direct" && !value.provider) {
      ctx.addIssue({
        code: zod_1.z.ZodIssueCode.custom,
        message: "Step and provider are required",
        path: ["provider"],
      });
    }
  });
exports.oauthExchangeSchema = zod_1.z.object({
  code: zod_1.z.string().trim().min(1),
  redirectUri: zod_1.z.string().trim().min(1),
  codeVerifier: zod_1.z.string().trim().min(1),
  state: zod_1.z.string().optional(),
});
exports.oauthPollSchema = zod_1.z.object({
  deviceCode: zod_1.z.string().trim().min(1),
  codeVerifier: zod_1.z.string().optional(),
  extraData: zod_1.z.unknown().optional(),
});
exports.cursorImportSchema = zod_1.z.object({
  accessToken: zod_1.z.string().trim().min(1, "Access token is required"),
  machineId: zod_1.z.string().trim().min(1, "Machine ID is required"),
});
exports.kiroImportSchema = zod_1.z.object({
  refreshToken: zod_1.z.string().trim().min(1, "Refresh token is required"),
});
exports.kiroSocialExchangeSchema = zod_1.z.object({
  code: zod_1.z.string().trim().min(1, "Code is required"),
  codeVerifier: zod_1.z.string().trim().min(1, "Code verifier is required"),
  provider: zod_1.z.enum(["google", "github"]),
});
exports.cloudCredentialUpdateSchema = zod_1.z.object({
  provider: zod_1.z.string().trim().min(1, "Provider is required"),
  credentials: zod_1.z
    .object({
      accessToken: zod_1.z.string().optional(),
      refreshToken: zod_1.z.string().optional(),
      expiresIn: zod_1.z.coerce.number().positive().optional(),
    })
    .strict()
    .superRefine(function (value, ctx) {
      if (
        value.accessToken === undefined &&
        value.refreshToken === undefined &&
        value.expiresIn === undefined
      ) {
        ctx.addIssue({
          code: zod_1.z.ZodIssueCode.custom,
          message: "At least one credential field must be provided",
          path: [],
        });
      }
    }),
});
exports.cloudResolveAliasSchema = zod_1.z.object({
  alias: zod_1.z.string().trim().min(1, "Missing alias"),
});
exports.cloudModelAliasUpdateSchema = zod_1.z.object({
  model: zod_1.z.string().trim().min(1, "Model and alias required"),
  alias: zod_1.z.string().trim().min(1, "Model and alias required"),
});
exports.cloudSyncActionSchema = zod_1.z.object({
  action: zod_1.z.enum(["enable", "sync", "disable"]),
});
exports.updateComboSchema = zod_1.z
  .object({
    name: zod_1.z
      .string()
      .min(1, "Name is required")
      .max(100)
      .regex(/^[a-zA-Z0-9_/.-]+$/, "Name can only contain letters, numbers, -, _, / and .")
      .optional(),
    models: zod_1.z.array(comboModelEntry).optional(),
    strategy: comboStrategySchema.optional(),
    config: comboRuntimeConfigSchema.optional(),
    isActive: zod_1.z.boolean().optional(),
  })
  .superRefine(function (value, ctx) {
    if (
      value.name === undefined &&
      value.models === undefined &&
      value.strategy === undefined &&
      value.config === undefined &&
      value.isActive === undefined
    ) {
      ctx.addIssue({
        code: zod_1.z.ZodIssueCode.custom,
        message: "No valid fields to update",
        path: [],
      });
    }
  });
exports.testComboSchema = zod_1.z.object({
  comboName: zod_1.z.string().trim().min(1, "comboName is required"),
});
exports.dbBackupRestoreSchema = zod_1.z.object({
  backupId: zod_1.z.string().trim().min(1, "backupId is required"),
});
exports.evalRunSuiteSchema = zod_1.z.object({
  suiteId: zod_1.z.string().trim().min(1, "suiteId is required"),
  outputs: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()),
});
exports.updateKeyPermissionsSchema = zod_1.z
  .object({
    allowedModels: zod_1.z.array(zod_1.z.string().trim().min(1)).max(1000).optional(),
    noLog: zod_1.z.boolean().optional(),
  })
  .superRefine(function (value, ctx) {
    if (value.allowedModels === undefined && value.noLog === undefined) {
      ctx.addIssue({
        code: zod_1.z.ZodIssueCode.custom,
        message: "No valid fields to update",
        path: [],
      });
    }
  });
exports.createProviderNodeSchema = zod_1.z
  .object({
    name: zod_1.z.string().trim().min(1, "Name is required"),
    prefix: zod_1.z.string().trim().min(1, "Prefix is required"),
    apiType: zod_1.z.enum(["chat", "responses"]).optional(),
    baseUrl: zod_1.z.string().trim().min(1).optional(),
    type: zod_1.z.enum(["openai-compatible", "anthropic-compatible"]).optional(),
  })
  .superRefine(function (value, ctx) {
    var nodeType = value.type || "openai-compatible";
    if (nodeType === "openai-compatible" && !value.apiType) {
      ctx.addIssue({
        code: zod_1.z.ZodIssueCode.custom,
        message: "Invalid OpenAI compatible API type",
        path: ["apiType"],
      });
    }
  });
exports.updateProviderNodeSchema = zod_1.z.object({
  name: zod_1.z.string().trim().min(1, "Name is required"),
  prefix: zod_1.z.string().trim().min(1, "Prefix is required"),
  apiType: zod_1.z.enum(["chat", "responses"]).optional(),
  baseUrl: zod_1.z.string().trim().min(1, "Base URL is required"),
});
exports.providerNodeValidateSchema = zod_1.z.object({
  baseUrl: zod_1.z.string().trim().min(1, "Base URL and API key required"),
  apiKey: zod_1.z.string().trim().min(1, "Base URL and API key required"),
  type: zod_1.z.enum(["openai-compatible", "anthropic-compatible"]).optional(),
});
exports.updateProviderConnectionSchema = zod_1.z
  .object({
    name: zod_1.z.string().max(200).optional(),
    priority: zod_1.z.coerce.number().int().min(1).max(100).optional(),
    globalPriority: zod_1.z
      .union([zod_1.z.coerce.number().int().min(1).max(100), zod_1.z.null()])
      .optional(),
    defaultModel: zod_1.z.union([zod_1.z.string().max(200), zod_1.z.null()]).optional(),
    isActive: zod_1.z.boolean().optional(),
    apiKey: zod_1.z.string().max(10000).optional(),
    testStatus: zod_1.z.string().max(50).optional(),
    lastError: zod_1.z.union([zod_1.z.string(), zod_1.z.null()]).optional(),
    lastErrorAt: zod_1.z.union([zod_1.z.string(), zod_1.z.null()]).optional(),
    lastErrorType: zod_1.z.union([zod_1.z.string(), zod_1.z.null()]).optional(),
    lastErrorSource: zod_1.z.union([zod_1.z.string(), zod_1.z.null()]).optional(),
    errorCode: zod_1.z.union([zod_1.z.string(), zod_1.z.null()]).optional(),
    rateLimitedUntil: zod_1.z.union([zod_1.z.string(), zod_1.z.null()]).optional(),
    lastTested: zod_1.z.union([zod_1.z.string(), zod_1.z.null()]).optional(),
    healthCheckInterval: zod_1.z.coerce.number().int().min(0).optional(),
  })
  .superRefine(function (value, ctx) {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({
        code: zod_1.z.ZodIssueCode.custom,
        message: "No valid fields to update",
        path: [],
      });
    }
  });
exports.providersBatchTestSchema = zod_1.z
  .object({
    mode: zod_1.z.enum(["provider", "oauth", "free", "apikey", "compatible", "all"]),
    providerId: zod_1.z.string().trim().min(1).optional(),
  })
  .superRefine(function (value, ctx) {
    if (value.mode === "provider" && !value.providerId) {
      ctx.addIssue({
        code: zod_1.z.ZodIssueCode.custom,
        message: "providerId is required when mode=provider",
        path: ["providerId"],
      });
    }
  });
exports.validateProviderApiKeySchema = zod_1.z.object({
  provider: zod_1.z.string().trim().min(1, "Provider and API key required"),
  apiKey: zod_1.z.string().trim().min(1, "Provider and API key required"),
});
var geminiPartSchema = zod_1.z
  .object({
    text: zod_1.z.string().optional(),
  })
  .catchall(zod_1.z.unknown());
var geminiContentSchema = zod_1.z
  .object({
    role: zod_1.z.string().optional(),
    parts: zod_1.z.array(geminiPartSchema).optional(),
  })
  .catchall(zod_1.z.unknown());
exports.v1betaGeminiGenerateSchema = zod_1.z
  .object({
    contents: zod_1.z.array(geminiContentSchema).optional(),
    systemInstruction: zod_1.z
      .object({
        parts: zod_1.z.array(geminiPartSchema).optional(),
      })
      .catchall(zod_1.z.unknown())
      .optional(),
    generationConfig: zod_1.z
      .object({
        stream: zod_1.z.boolean().optional(),
        maxOutputTokens: zod_1.z.coerce.number().int().min(1).optional(),
        temperature: zod_1.z.coerce.number().optional(),
        topP: zod_1.z.coerce.number().optional(),
      })
      .catchall(zod_1.z.unknown())
      .optional(),
  })
  .catchall(zod_1.z.unknown())
  .superRefine(function (value, ctx) {
    if (!value.contents && !value.systemInstruction) {
      ctx.addIssue({
        code: zod_1.z.ZodIssueCode.custom,
        message: "contents or systemInstruction is required",
        path: [],
      });
    }
  });
exports.cliMitmStartSchema = zod_1.z.object({
  apiKey: zod_1.z.string().trim().min(1, "Missing apiKey"),
  sudoPassword: zod_1.z.string().optional(),
});
exports.cliMitmStopSchema = zod_1.z.object({
  sudoPassword: zod_1.z.string().optional(),
});
exports.cliMitmAliasUpdateSchema = zod_1.z.object({
  tool: zod_1.z.string().trim().min(1, "tool and mappings required"),
  mappings: zod_1.z.record(zod_1.z.string(), zod_1.z.string().optional()),
});
exports.cliBackupMutationSchema = zod_1.z
  .object({
    tool: zod_1.z.string().trim().min(1).optional(),
    toolId: zod_1.z.string().trim().min(1).optional(),
    backupId: zod_1.z.string().trim().min(1, "tool and backupId are required"),
  })
  .superRefine(function (value, ctx) {
    if (!value.tool && !value.toolId) {
      ctx.addIssue({
        code: zod_1.z.ZodIssueCode.custom,
        message: "tool and backupId are required",
        path: ["tool"],
      });
    }
  });
var envKeySchema = zod_1.z
  .string()
  .trim()
  .min(1, "Environment key is required")
  .max(120)
  .regex(/^[A-Z_][A-Z0-9_]*$/, "Invalid environment key format");
var envValueSchema = zod_1.z
  .union([zod_1.z.string(), zod_1.z.number(), zod_1.z.boolean()])
  .transform(function (value) {
    return String(value);
  })
  .refine(function (value) {
    return value.length > 0;
  }, "Environment value is required")
  .refine(function (value) {
    return value.length <= 10000;
  }, "Environment value is too long");
exports.cliSettingsEnvSchema = zod_1.z.object({
  env: zod_1.z.record(envKeySchema, envValueSchema).refine(function (value) {
    return Object.keys(value).length > 0;
  }, "env must contain at least one key"),
});
exports.cliModelConfigSchema = zod_1.z.object({
  baseUrl: zod_1.z.string().trim().min(1, "baseUrl and model are required"),
  apiKey: zod_1.z.string().optional(),
  model: zod_1.z.string().trim().min(1, "baseUrl and model are required"),
});
exports.codexProfileNameSchema = zod_1.z.object({
  name: zod_1.z.string().trim().min(1, "Profile name is required"),
});
exports.codexProfileIdSchema = zod_1.z.object({
  profileId: zod_1.z.string().trim().min(1, "profileId is required"),
});
exports.guideSettingsSaveSchema = zod_1.z.object({
  baseUrl: zod_1.z.string().trim().min(1).optional(),
  apiKey: zod_1.z.string().optional(),
  model: zod_1.z.string().trim().min(1, "Model is required"),
});
// ──── Helper ────
/**
 * Parse and validate request body with a Zod schema.
 * Returns { success: true, data } or { success: false, error }.
 */
function validateBody(schema, body) {
  var _a;
  var result = schema.safeParse(body);
  if (result.success) {
    return { success: true, data: result.data };
  }
  var issues = Array.isArray((_a = result.error) === null || _a === void 0 ? void 0 : _a.issues)
    ? result.error.issues
    : [];
  return {
    success: false,
    error: {
      message: "Invalid request",
      details: issues.map(function (e) {
        return {
          field: e.path.join("."),
          message: e.message,
        };
      }),
    },
  };
}
