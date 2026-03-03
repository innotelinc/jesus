# Relatório Expandido — OmniRoute + Omni VS Code Extension + MCP/A2A

Data: 2026-03-03
Autor: Codex (análise técnica independente)

## 1. Resumo Executivo

A hipótese principal está correta: **Switchboard e OmniRoute são complementares**.

- **Switchboard** opera na camada de orquestração local de agentes (terminal, workflow, inbox de arquivos, MCP embutido na extensão).
- **OmniRoute** opera na camada de gateway/proxy de LLM (roteamento, fallback, tradução de formato, custo, quotas, multi-provider).

A combinação dos dois cria um efeito de plataforma:

1. **Extensão Omni (fork do Switchboard)** para coordenação de agentes com UX forte dentro do VS Code.
2. **OmniRoute MCP Server + A2A Server** para expor inteligência operacional (health, quota, custo, combos, políticas) para agentes e para outros sistemas.

### Conclusão de viabilidade

- **Viabilidade técnica**: Alta.
- **Viabilidade de produto**: Alta, com diferenciação clara.
- **Viabilidade de execução**: Média-Alta, desde que faseada em entregas pequenas e com contratos estáveis.

### Recomendação estratégica

Implementar em 4 ondas:

1. **Wave 1 (2-3 semanas):** MCP Server essencial no OmniRoute + cliente MCP na extensão Omni.
2. **Wave 2 (2-4 semanas):** extensão Omni forkada e priorizando OmniRoute como provider principal.
3. **Wave 3 (3-4 semanas):** A2A Server no OmniRoute + task lifecycle + streaming.
4. **Wave 4 (3-6 semanas):** Auto-Combo Engine autogerenciado + roteamento contextual e otimização contínua.

---

## 2. Método e Fontes

Esta análise foi refeita do zero, com três frentes:

1. **Leitura do código do OmniRoute local** (rotas API, `open-sse`, DB, auth, métricas, CLI tooling).
2. **Leitura do código do Switchboard** (clone local do repositório, não apenas README).
3. **Benchmark externo com fontes primárias** (MCP, A2A, VS Code, GitHub Copilot, LiteLLM, Microsoft MCP Gateway, Kong).

### Fontes principais (acessadas em 2026-03-03)

- Switchboard: https://github.com/TentacleOpera/switchboard
- MCP Spec (revision 2025-11-25): https://modelcontextprotocol.io/specification/2025-11-05
- MCP Security Best Practices: https://modelcontextprotocol.io/specification/draft/basic/security_best_practices
- A2A Spec (v0.3): https://a2a-protocol.org/latest/specification/
- VS Code 1.102 release notes (MCP stable in agent mode): https://code.visualstudio.com/updates/v1_102
- VS Code MCP docs: https://code.visualstudio.com/docs/copilot/chat/mcp-servers
- GitHub Copilot + MCP (public preview): https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/use-the-github-copilot-coding-agent-with-mcp
- LiteLLM README (A2A + MCP Gateway): https://github.com/BerriAI/litellm
- Microsoft MCP Gateway: https://github.com/microsoft/mcp-gateway
- Kong Konnect MCP Server: https://github.com/Kong/mcp-konnect
- Kong MCP Registry announcement (2026-02-02): https://konghq.com/blog/news-announcements/kong-just-launched-the-worlds-first-mcp-server-registry
- OpenClaw model failover/auth order: https://github.com/openclaw/openclaw/blob/main/docs/concepts/model-failover.md

Observação: o conteúdo do Switchboard também inclui um documento próprio sobre compliance e ToS (interno do projeto), usado aqui como insumo arquitetural, não como parecer jurídico definitivo.

---

## 3. Diagnóstico Técnico do OmniRoute (estado atual)

### 3.1 Escopo atual do backend

O projeto já está em escala relevante:

- `124` arquivos `route.ts` em `src/app/api`.
- `18` endpoints OpenAI-like em `src/app/api/v1`.
- `37` providers declarados em `src/shared/constants/providers.ts`.
- Camada `open-sse` robusta com executores, tradutores, rate-limit manager, combo engine e serviços de sessão.

### 3.2 Capacidades já prontas (e reaproveitáveis para MCP/A2A)

O ponto mais importante: **muita coisa que um MCP/A2A precisaria já existe**.

- Saúde e resiliência:
  - `/api/monitoring/health`
  - `/api/resilience`
  - `/api/rate-limits`
  - `/api/token-health`
- Combos e fallback:
  - `/api/combos`, `/api/combos/metrics`, `/api/combos/test`
  - Estratégias já implementadas: `priority`, `weighted`, `round-robin`, `random`, `least-used`, `cost-optimized`
- Observabilidade e custo:
  - `/api/provider-metrics`
  - `/api/telemetry/summary`
  - `/api/usage/*` (analytics, call logs, request logs, proxy logs, budget)
- Segurança e governança:
  - API key com permissões de modelo (`api_keys.allowed_models`)
  - middleware com JWT/API key para rotas de gestão
  - sanitização/prompt injection guard no pipeline
- Camada de configuração para CLIs:
  - `/api/cli-tools/*` já integra OpenClaw, Codex, Claude etc.

### 3.3 Gap real

O gap não é de capacidade de negócio, é de **protocolo/interface**:

- Não existe hoje um **MCP server do OmniRoute**.
- Não existe hoje um **A2A endpoint** com Agent Card + task lifecycle.

Isso reduz risco do projeto: o investimento é principalmente de encapsulamento, contrato e produto, não de reinvenção do core.

---

## 4. Diagnóstico Técnico do Switchboard (estado atual)

Com base no código (`/tmp/switchboard-research`):

- Extensão VS Code com sidebar/webview, watcher de inbox e automações de workflow.
- MCP server embutido (`@modelcontextprotocol/sdk`) em `stdio`.
- Protocolo de coordenação em arquivos `.switchboard/*` + automação de terminal (`terminal.sendText`).
- Ferramentas MCP focadas em orquestração local (`start_workflow`, `send_message`, `check_inbox`, `run_in_terminal`, etc.).
- Forte foco em “local-first” e compliance ToS em providers sensíveis.

### Leitura estratégica

Switchboard resolve muito bem “**quem faz o trabalho e quando**”.
OmniRoute resolve “**qual modelo/provedor atenderá com menor custo/risco**”.

A fusão cria uma camada de decisão completa: orquestração de agentes + inteligência de roteamento.

---

## 5. Workstream A — Omni VS Code Extension (fork do Switchboard)

### 5.1 Fork vs Greenfield

### Recomendação

**Fork + rebrand + redução de superfície inicial**.

Motivos:

- Tempo de entrega menor.
- Já existe runtime testado para workflows, terminal grid e inbox watcher.
- Já existe MCP interno que pode ser adaptado para cliente OmniRoute.

### Cuidado

Fork sem governança vira dívida. Definir desde o dia 1:

- O que permanecerá compatível com upstream.
- O que será “Omni-only”.
- Estratégia de merge trimestral ou semestral.

### 5.2 Arquitetura alvo da extensão

### Módulos novos na extensão Omni

1. **`OmniRouteClient`**

- SDK local (TS) para chamadas ao OmniRoute.
- Suporte a auth via API key/JWT local.
- Retry com backoff e timeout curto.

2. **`DecisionPanel` (sidebar)**

- Health por provider/combos.
- Quota/usage por conexão e por sessão de trabalho.
- Custo estimado da execução atual.

3. **`DispatchPolicyEngine`**

- Antes de enviar tarefa a agente/modelo, consulta:
  - quota disponível
  - latência recente
  - orçamento diário
  - lockouts/circuit breakers
- Escolhe rota sugerida com explicação curta (“porque escolheu”).

4. **`ContextualHints`**

- Detecta tipo de tarefa (planejamento, refactor, teste, docs, bugfix urgente).
- Sugere combo/modelo por classe de tarefa.

### 5.3 Funcionalidades criativas (além do baseline anterior)

1. **Preflight de tarefa com score de risco**

- Antes do dispatch: score de risco de custo/latência/falha.
- Usuário aprova ou força.

2. **Dry-run de roteamento**

- Simula o caminho de fallback sem executar a tarefa.
- Mostra “árvore de queda” provável.

3. **Modo “Budget Guard” por sessão IDE**

- Define teto de custo por sessão de trabalho.
- Auto-reduz agressividade de modelo ao chegar em limiar.

4. **Mode packs por contexto**

- “Ship fast”, “Cost saver”, “Quality first”, “Offline friendly”.
- Cada pack altera pesos do policy engine.

5. **Checkpoint inteligente para handoff humano**

- Quando confiança cai abaixo de threshold, extensão recomenda revisão humana antes de continuar cadeia.

### 5.4 Segurança e compliance

- Não armazenar segredo em texto no workspace.
- Integração com o modelo de API key existente do OmniRoute.
- Logs redigidos (sem tokens).
- Botão “kill switch” para automação de terminal.
- Limitar ações perigosas em ambiente não confiável.

### 5.5 Esforço estimado (workstream A)

- Base funcional (fork + provider Omni + painel mínimo): **10-14 dias úteis**.
- Funcionalidades avançadas de dispatch/packs: **+8-12 dias úteis**.
- Hardening + testes e packaging: **+5-8 dias úteis**.

Total provável: **23-34 dias úteis**.

---

## 6. Workstream B — MCP + A2A no OmniRoute

### 6.1 Princípios

1. Começar com ferramentas de alto valor e baixo risco.
2. Reusar endpoints existentes para reduzir manutenção.
3. Segurança por padrão (escopo mínimo + auditoria).
4. Contratos estáveis versionados (`v1alpha`, `v1`).

### 6.2 MCP Server do OmniRoute (proposta)

#### 6.2.1 Ferramentas essenciais (Fase 1)

1. `omniroute_get_health`

- Fonte: `/api/monitoring/health`, `/api/resilience`, `/api/rate-limits`

2. `omniroute_list_combos`

- Fonte: `/api/combos`

3. `omniroute_get_combo_metrics`

- Fonte: `/api/combos/metrics`

4. `omniroute_switch_combo`

- Fonte: atualização de configuração padrão (settings)

5. `omniroute_check_quota`

- Fonte: `/api/usage/[connectionId]` + token health

6. `omniroute_route_request`

- Wrapper controlado para envio em `/v1/chat/completions` e `/v1/responses`
- Inclui metadados de sessão/objetivo

7. `omniroute_cost_report`

- Fonte: `/api/usage/analytics`, `/api/usage/call-logs`, `/api/usage/budget`

8. `omniroute_list_models_catalog`

- Fonte: `/api/models/catalog` + `/v1/models`

#### 6.2.2 Ferramentas avançadas (Fase 2+)

9. `omniroute_simulate_route` (dry-run)
10. `omniroute_set_budget_guard`
11. `omniroute_set_resilience_profile`
12. `omniroute_test_combo`
13. `omniroute_get_provider_metrics`
14. `omniroute_get_proxy_path`
15. `omniroute_toggle_rate_limit_protection`
16. `omniroute_get_session_snapshot`

#### 6.2.3 Contrato e segurança MCP

- Transporte inicial: `stdio` para uso local e `streamable-http` opcional em ambiente gerenciado.
- Seguir práticas do MCP spec e security best practices:
  - validação de origem para endpoints HTTP locais
  - mitigação de DNS rebinding
  - evitar token passthrough inseguro
- Controle de escopo por API key (`allowed_models` + escopos de ferramenta futuros).

### 6.3 A2A Server no OmniRoute (proposta)

#### 6.3.1 Contrato base

- `GET /.well-known/agent.json` (Agent Card)
- JSON-RPC 2.0:
  - `message/send`
  - `message/stream`
  - `tasks/get`
  - `tasks/cancel`
  - `tasks/pushNotification/set` e `.../get`

#### 6.3.2 Papel do OmniRoute como agente A2A

O OmniRoute não precisa virar “um agente que coda”; ele pode ser um **agente roteador especializado**:

- Recebe tarefas com contexto e SLO.
- Resolve estratégia de execução (modelo/provider/combo).
- Retorna resultado + trilha de decisão + custos.

#### 6.3.3 Extensões de valor

1. `routing_explanation` em cada task result.
2. `cost_envelope` (estimado vs real).
3. `resilience_trace` (fallbacks acionados).
4. `policy_verdict` (por que permitiu/bloqueou rota).

### 6.4 Auto-Combo Engine autogerenciado (proposta criativa)

Objetivo: transformar combo estático em sistema adaptativo.

#### Score sugerido

`score = wq*quota + wh*health + wc*cost_inv + wl*latency_inv + wt*task_fit + ws*stability`

Onde:

- `quota`: capacidade residual de uso
- `health`: estado de circuito/erro recente
- `cost_inv`: inverso do custo (mais barato, maior score)
- `latency_inv`: inverso da latência p95
- `task_fit`: aderência ao tipo de tarefa
- `stability`: variância de erro/latência

#### Comportamentos

1. **Self-healing:** exclui temporariamente perfis/modelos degradados.
2. **Bandit exploration controlado:** pequena exploração para evitar overfitting.
3. **Policy cap:** nunca viola limites de custo/compliance definidos.
4. **Fallback determinístico em modo incidente:** quando risco alto, prioriza previsibilidade.

### 6.5 Persistência necessária (mínima)

Novas tabelas (SQLite) sugeridas:

- `mcp_tool_audit`
- `a2a_tasks`
- `a2a_task_events`
- `routing_decisions`
- `combo_adaptation_state`

Observação: o projeto já tem base madura de migração versionada em `src/lib/db/migrationRunner.ts`, o que facilita evolução segura de schema.

### 6.6 Esforço estimado (workstream B)

- MCP essencial + auth + auditoria: **10-15 dias úteis**.
- A2A core + task lifecycle + streaming: **12-18 dias úteis**.
- Auto-Combo Engine inicial (regras + score + guardrails): **10-16 dias úteis**.
- Hardening/perf/testes: **7-12 dias úteis**.

Total provável: **39-61 dias úteis**.

---

## 7. Arquitetura Integrada (extensão + OmniRoute)

Fluxo recomendado:

1. Usuário/agente na extensão cria tarefa.
2. Extensão consulta MCP do OmniRoute (`health`, `quota`, `combos`).
3. `DispatchPolicyEngine` define rota sugerida.
4. Extensão envia requisição via `omniroute_route_request`.
5. OmniRoute executa com fallback/telemetria.
6. Resultado retorna com:

- output
- custo
- rota usada
- eventos de fallback

7. Extensão atualiza painel e histórico da sessão.

Resultado prático: UX de “agente inteligente” sem esconder governança operacional.

---

## 8. Benchmark competitivo (o que já existe e onde diferenciar)

### 8.1 LiteLLM

Ponto forte: gateway consolidado com endpoints amplos e narrativa de AI Hub, incluindo A2A e MCP.

Implicação para OmniRoute:

- Não competir só por “tem MCP/A2A”.
- Diferenciar por profundidade em:
  - combos multi-estratégia
  - integração direta com CLIs de coding
  - governança de quota e fallback por assinatura/OAuth + API key

### 8.2 Microsoft MCP Gateway

Ponto forte: camada enterprise de gateway MCP com roteamento stateful por sessão e control plane.

Implicação:

- Validar que “MCP Gateway dedicado” virou categoria real.
- Oportunidade OmniRoute: foco dev-first e LLM routing prático, sem dependência K8s para casos locais.

### 8.3 Kong MCP (mcp-konnect + MCP Registry)

Ponto forte: governança e integração com ecossistema API management.

Implicação:

- Mercado começou a institucionalizar descoberta/governança de MCP.
- Oportunidade OmniRoute: ser forte no fluxo de engenharia (IDE/CLI/task routing), não só no plano corporativo de APIs.

### 8.4 Switchboard

Ponto forte: orquestração local e workflow de agentes com baixo atrito.

Implicação:

- Excelente base para fork da extensão Omni.
- Mas sem camada avançada de roteamento multi-provider como a do OmniRoute.

### 8.5 OpenClaw

Ponto forte: failover modelado, rotação de perfis de auth e fallback de modelo bem documentados.

Implicação:

- Boa referência para o design de “auto-managed combos”.
- Evitar claims não comprovadas; focar no que é claro: `auth.order`, rotação por perfil, fallback model-aware.

---

## 9. Prós e Contras da Estratégia Completa

### Prós

1. Diferenciação forte no ecossistema de agentes/IDEs.
2. Reaproveitamento alto de capacidades já existentes do OmniRoute.
3. Melhor retenção: gateway + extensão + protocolo = maior lock-in positivo por valor.
4. Base para produto enterprise (auditoria, política, orçamento, observabilidade).

### Contras

1. Complexidade de produto aumenta muito (2 superfícies simultâneas).
2. Risco de manutenção de fork do Switchboard.
3. A2A ainda evolui rápido; risco de churn de contrato.
4. Requer governança clara para não misturar automação agressiva com compliance sensível.

---

## 10. Registro de Riscos e Mitigações

1. **Risco:** instabilidade de protocolo (MCP/A2A evoluindo).

- Mitigação: versionar internamente (`v1alpha`) e usar adaptadores.

2. **Risco:** extensão virar “monolito de features”.

- Mitigação: plugin architecture interna e feature flags por módulo.

3. **Risco:** regressão de segurança ao expor tools operacionais.

- Mitigação: RBAC por API key + auditoria + deny-by-default.

4. **Risco:** custo operacional de observabilidade.

- Mitigação: métricas com retenção curta por default e export opcional.

5. **Risco:** acoplamento excessivo com upstream Switchboard.

- Mitigação: definir core próprio Omni para decisão de roteamento; upstream só para orquestração/UI base.

---

## 11. KPI de sucesso

1. **Confiabilidade de execução**

- sucesso de task em primeira tentativa
- taxa de fallback efetivo

2. **Eficiência econômica**

- custo médio por tarefa
- custo evitado por auto-combo

3. **Qualidade de experiência**

- latência p95 end-to-end
- tempo de decisão de rota

4. **Operabilidade**

- MTTR de incidentes de provider
- taxa de uso de dry-run/simulação

5. **Adoção**

- sessões ativas na extensão
- tasks via MCP/A2A por dia

---

## 12. Plano de execução sugerido

### Fase 0 — Contratos (3-5 dias)

- Definir contratos MCP e A2A mínimos.
- Definir escopos de autorização por ferramenta.
- Definir formatos de audit log.

### Fase 1 — MCP essencial (10-15 dias)

- Entregar 8 ferramentas essenciais.
- Integrar com endpoints existentes.
- Publicar documentação e exemplos.

### Fase 2 — Extensão Omni MVP (10-14 dias)

- Fork Switchboard + rebrand.
- OmniRoute provider-first.
- Painel de health/quota/custo básico.

### Fase 3 — A2A core (12-18 dias)

- Agent Card + lifecycle de tasks + streaming.
- `routing_explanation` e `cost_envelope` no resultado.

### Fase 4 — Auto-Combo v1 (10-16 dias)

- Score adaptativo + guardrails + simulação.
- Métricas de melhoria contínua.

---

## 13. Decisão recomendada (objetiva)

Se a prioridade é **time-to-value**, comece por:

1. MCP essencial no OmniRoute.
2. Extensão Omni forkada em modo “thin client” (consome MCP + APIs já existentes).

Se a prioridade é **diferenciação estrutural de médio prazo**, em seguida:

3. A2A server.
4. Auto-Combo autogerenciado.

Essa ordem reduz risco e cria valor progressivo sem bloquear as ambições maiores.

---

## 14. Apêndice — Evidências objetivas do código atual

- `src/lib/localDb.ts` mantém contrato de re-export (boa base para evoluções sem quebrar consumidores).
- `open-sse/services/combo.ts` já implementa múltiplas estratégias de combo e fallback com métricas.
- `src/app/api/monitoring/health/route.ts`, `src/app/api/resilience/route.ts`, `src/app/api/rate-limits/route.ts` já expõem estado operacional útil para MCP tools.
- `src/app/api/usage/*` e `src/lib/usageAnalytics.ts` já entregam base para relatórios de custo/sessão.
- `src/app/api/cli-tools/*` mostra maturidade de integração com ecossistema de coding agents (incluindo OpenClaw e Codex).
