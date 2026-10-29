---
name: skill-creator
description: Create and improve reusable skills for the Bill Splitter project. Use when the user wants to turn a repeated project workflow into a skill, customize existing project guidance, or document steps for features, bug fixes, calculations, UI, and browser testing.
metadata:
  origin: anthropics
---

# Skill Creator for Bill Splitter

Use this skill to turn repeated Bill Splitter work into concise, discoverable project-local skills. Do not invoke it for routine feature implementation unless the user asks to create or change a skill.

## When to use

- Start a new skill for a recurring workflow or project pattern.
- Improve, rewrite, or tighten an existing skill.
- Create a project-local instruction set for coding standards, testing, or UX workflows.
- Turn a specific manual process into a reusable agent workflow.
- Add or adjust skill metadata so the skill triggers reliably in the right circumstances.

## Goal

Turn a useful workflow into a compact, well-structured skill that is easy for an agent to discover and follow.

## Workflow

### 1. Capture intent

Identify:
- What should the skill enable the agent to do?
- When should it trigger?
- What output or file changes should result?
- What constraints or tool dependencies apply?

If the user already described a workflow, extract the important steps and patterns from the conversation before writing anything.

### 2. Interview and research

Ask only the missing questions that affect the final skill:
- what examples or edge cases matter
- what inputs and outputs are expected
- what project rules or tools are required
- whether the skill should be a strict workflow or a lighter guidance layer

Use relevant docs or repo context, but keep the skill focused and avoid over-engineering.

### 3. Draft the skill structure

Use the standard local skill layout:

```text
.opencode/skills/
  your-skill-name/
    SKILL.md
    scripts/
    references/
```

Each skill usually contains:
- YAML frontmatter with `name` and `description`
- short purpose and trigger guidance
- the operational workflow
- examples or checklists when helpful
- optional bundled scripts or references for heavier tasks

### 4. Write the YAML frontmatter

Use:

```yaml
---
name: skill-name
description: Brief but specific trigger text for when this skill should be used.
metadata:
  origin: project-or-source
---
```

The `description` is critical: it acts as the main trigger. Make it explicit about both the task and the situations that should activate the skill.

### 5. Keep the body practical

A good skill is:
- compact and readable
- specific about required steps
- not overfilled with unrelated theory
- written in imperative voice
- explicit about expected outputs, files, and checks

Prefer a clear workflow over long conceptual explanation.

### 6. Validate and iterate

For skills that produce deterministic output, test with prompts and expected results.

For repo-specific skills:
- check whether the trigger is obvious
- confirm the skill matches the real workflow
- make sure the instructions fit the project structure
- keep examples aligned with the repository

If the user wants a longer-term skill practice, add a small evaluation set and refine the skill based on real outcomes.

## Bill Splitter project context

Project skills are loaded from `.opencode/skills` through `opencode.json`. Keep new skills there and follow the existing `SKILL.md` frontmatter conventions.

The app is a small static SPA: `index.html` holds markup, `styles.css` holds styling, and `app.js` owns state, calculations, and UI handlers. There is no build step or framework. Prefer skills that preserve this architecture and avoid introducing dependencies.

When designing a skill, match it to the relevant recurring scenario:

- **Feature or bug fix:** inspect existing code and reproduce the behavior first; preserve existing UI and state behavior; make a focused change; verify the user-visible result.
- **Calculation changes:** preserve cent-level allocation and the documented rules for discounts, tax, tips, participants, and currency. Check `AGENTS.md` before encoding domain assumptions.
- **UI and accessibility:** keep Russian interface copy consistent, maintain responsive behavior, and use the existing accessibility and frontend-design skills rather than duplicating their broad guidance.
- **Browser testing:** use the project’s existing Playwright scripts and run the narrowest relevant regression test. The tests start their own server.
- **Documentation or maintenance:** update only documentation directly affected by a code change; keep the no-build, static-app workflow intact.

Use the established test mapping when a skill needs to describe validation:

- `tests/test_equal_mode_no_people.py` for equal-split behavior with no participants.
- `tests/test_mvp_scenarios.py` for core bill flows, state persistence, and history.
- `tests/test_summary_export.py` for copy and print/PDF.
- `tests/test_currency_and_item_rounding.py` for currency precision and item allocation.

Prefer a focused skill for a specific repeated workflow over one large skill that duplicates all project skills. In Russian-language workflows, use concise Russian examples and user-facing messages.

## Default output structure for a new skill

```markdown
---
name: skill-name
description: Use when ...
metadata:
  origin: project
---

# Skill Name

## When to use

## Goal

## Workflow

## Project notes

## Validation
```

## Quality bar

Before finalizing a skill:
- make the trigger clear enough that the right agent will notice it
- keep the skill shorter than a full handbook
- avoid generic advice when a project-specific workflow is better
- include only instructions that are actually needed to complete the task

## Example usage

User: “Сделай skill для проверки UI и браузерных сценариев в этом проекте.”

Result: create a project-local skill in `.opencode/skills/.../SKILL.md` with a description, workflow, and project-specific validation steps.

This skill is meant to turn repeatable Bill Splitter work into reusable, project-aware guidance without bloating the repo or duplicating existing skills.
