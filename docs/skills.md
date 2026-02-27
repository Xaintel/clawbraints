# Skills Instaladas y Como se Instalaron

## Skills dentro de este repo

Este repo incluye la skill local:
- `ux-frontend-expert`
- Ubicacion: `skills/ux-frontend-expert/`
- Archivo principal: `skills/ux-frontend-expert/SKILL.md`

Esta skill se integra por convencion `AGENTS.md` y por referencia en `config/templates/agents.yaml` (UXAgent).

## Como fue instalada en este repo

Se copio la carpeta de skill al repo en:

```text
skills/ux-frontend-expert/
```

y se dejo documentada en:

```text
AGENTS.md
```

## Diferencia entre skills locales y skills del sistema

- Skills locales (este repo): viven en `skills/` y se versionan contigo.
- Skills del sistema Codex: viven en `$CODEX_HOME/skills` o rutas del host (no necesariamente en tu repo).

## Instalar nuevas skills

Opciones:
1. Copiar skill al folder `skills/<nombre>/` y documentarla en `AGENTS.md`.
2. Usar el skill del sistema `skill-installer` para instalar en `$CODEX_HOME/skills` (nivel usuario/host).

## Verificacion

Checklist rapido:
- Existe `skills/<nombre>/SKILL.md`.
- `AGENTS.md` lista la skill y trigger rule.
- Si aplica, `config/templates/agents.yaml` referencia la skill para el agente objetivo.

