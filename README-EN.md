<p align="center">
  <img src="./assets/material-map-logo.svg" alt="Material Map" width="112" />
</p>

<h1 align="center">Material Map</h1>

<p align="center"><strong>Give your local materials a structure you can explore.</strong><br />A local-first desktop workspace for importing files, finding evidence-backed relations, drawing topics, and asking your own AI about the material.</p>

<p align="center"><a href="./README.md">中文完整指南</a> · <a href="https://github.com/dongdonglog/Auto-connect-project/releases/latest">Latest release</a> · <a href="./LICENSE">MIT License</a></p>

<p align="center"><img src="./assets/screenshots/02-workbench.png" alt="Material Map workbench" width="960" /></p>

## What it is

Material Map is a local-first desktop material map and small knowledge base. It combines workspace management, full-text search, explainable relations, topic boards, and optional AI Q&A in one application.

Your original files stay under your control. The workspace stores local indexes, summaries, relations, topic layouts, and export data. AI is disabled until you configure and explicitly use it.

## Download

Current stable release: [v1.0.0](https://github.com/dongdonglog/Auto-connect-project/releases/tag/v1.0.0)

| Platform | Downloads |
| --- | --- |
| Windows x64 | [Installer](https://github.com/dongdonglog/Auto-connect-project/releases/download/v1.0.0/Material.Map.Setup.1.0.0.exe) · [Portable](https://github.com/dongdonglog/Auto-connect-project/releases/download/v1.0.0/Material.Map.1.0.0.exe) |
| macOS arm64 | [DMG](https://github.com/dongdonglog/Auto-connect-project/releases/download/v1.0.0/Material.Map-1.0.0-arm64.dmg) · [ZIP](https://github.com/dongdonglog/Auto-connect-project/releases/download/v1.0.0/Material.Map-1.0.0-arm64-mac.zip) |

The macOS build targets Apple Silicon. If macOS blocks the first launch, allow the app in System Settings → Privacy & Security. The packages are not notarized with an Apple Developer ID.

## Core capabilities

- Local workspaces with optional encryption, export, and restore.
- Material import for Markdown, TXT, CSV, JSON, HTML, PDF, and DOCX, plus notes and links.
- Explainable relations with expandable evidence and source jumps.
- Topic boards with directed relations, card styles, routing, arrows, selection, undo, and redo.
- Optional DeepSeek/OpenAI-compatible, Ollama, Anthropic, or Gemini Q&A with model and citation metadata.
- Local Material Map tools and reviewable Agent/MCP topic proposals.

## Complete workflow

### 1. Create or open a workspace

Choose **Create workspace**, **Open workspace**, or **Import workspace** on the welcome screen. An encrypted workspace requires a password of at least eight characters. Recent workspaces can be reopened from the same screen.

<p align="center"><img src="./assets/screenshots/01-welcome.png" alt="Material Map welcome screen" width="960" /></p>

### 2. Import material

Use **Import files**, **New material**, or **Add link** from the workbench. Wait for parsing and indexing to finish before exploring the new material.

<p align="center"><img src="./assets/screenshots/02-workbench.png" alt="Material Map workbench" width="960" /></p>

### 3. Manage and explore

Search or filter cards from the workbench. Open **Explore** to read a material in the center pane and inspect related materials and evidence on the right. You can hide relations, pin them to a topic, jump to source text, or ask AI to explain one relation.

<p align="center"><img src="./assets/screenshots/03-explorer.png" alt="Material Map explorer" width="960" /></p>

### 4. Build a topic board

Create a topic from the sidebar or from a multi-selection in the workbench. The board can add materials from the workspace, import files, create cards, or paste text into a card.

<p align="center"><img src="./assets/screenshots/05-topic-board.png" alt="Material Map topic board" width="960" /></p>

Drag from one card port to another to create a directed relation. Click a line to edit its name, ports, curve/straight/orthogonal path, label position, color, width, dash style, arrows, animation, or direction. Delete a card to remove it from the current topic only; delete a line to delete the formal relation.

Drag from empty canvas space to select cards and lines. Right-click inside the selected area, or use Control-click on macOS, to open the selection menu. `Delete` / `Backspace` removes the selection. `Space` + left drag, middle mouse, or trackpad scrolling pans the canvas. `Cmd/Ctrl+Z` and `Cmd/Ctrl+Shift+Z` undo and redo.

### 5. Configure AI and ask questions

Open **Model & Privacy**, add your provider URL and credentials, discover a model, enable AI, and validate the configuration. Cloud providers require explicit consent before material text can be sent outside the app.

<p align="center"><img src="./assets/screenshots/07-ai-settings.png" alt="Material Map AI settings" width="960" /></p>

Open **Knowledge Q&A** to ask about material counts, titles, content, relations, topics, or general technical questions. Answers show the actual model, retrieval mode, local tool usage, and source citations. Ten recent sessions are kept; older sessions are archived. Board changes requested through AI remain reviewable proposals until you accept them.

<p align="center"><img src="./assets/screenshots/04-knowledge-chat.png" alt="Material Map knowledge Q&A" width="960" /></p>

### 6. Watch folders and back up

Use **Folder sources** to add a directory, define include/exclude rules, watch changes, rescan, pause, resume, or remove a source. Removing a source keeps existing material records.

<p align="center"><img src="./assets/screenshots/06-folder-sources.png" alt="Material Map folder sources" width="960" /></p>

Use **Export workspace** to save a `.material-workspace` package. Import it from the welcome screen on another device. AI profiles and API keys are app-level settings and must be configured again on the destination device.

<p align="center"><img src="./assets/screenshots/08-export-workspace.png" alt="Material Map workspace export" width="960" /></p>

## Privacy

- Workspace databases, indexes, summaries, and relations are local by default.
- Original imported files are not moved or deleted by Material Map.
- AI is opt-in and only receives the context needed for a request after you configure and enable it.
- AI topic changes are proposals and require user review.

## Run from source

Requirements: Node.js 24+, Windows 10/11, or macOS 12+.

```bash
git clone https://github.com/dongdonglog/Auto-connect-project.git
cd Auto-connect-project
npm install
npm run dev
```

Useful commands: `npm run build`, `npm run test:ci`, `npm run test:e2e`, `npm run package:win`, `npm run package:mac`, `npm run build:mcp`, and `npm run check:readme`.

More product and technical documentation is available in [`ai-docs/`](./ai-docs/).

## License

Material Map is released under the [MIT License](./LICENSE).
