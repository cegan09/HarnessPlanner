# Harness Planner

A browser based wiring harness planning tool. 

![layout tab](https://github.com/cegan09/HarnessPlanner/blob/main/images/Layout.png)

## Running it
Two options for running:
1. Open `index.html` in any modern browser for a single instance
2. Serve the page using `py -m http.server 8347` to make it generally available to multiple instances at localhost:8347 or (local IP Address):8347

## AI Disclosure
This tool was created with the assistance of AI coding tools. I'm a mechanical engineer by training with no formal software education, so coding tools allow me to focus more time on the things I'm good at and less time fighting coding skill limitations. I do my best to review code before publishing it so that I have an understanding of what has been written and created. 


## Workflow

### 1. Sketch the harness shape (Layout tab)
- **Add point** (`A`): click empty space to drop a connector point. Click an existing harness line to split it and branch a new leg off it.
- **Connect** (`C`): click two points to join them, or click empty space to chain new points as you draw.
- **Jog** (`J`): click a line to insert a bend point, then drag it in Select mode to dogleg the leg (down/up then left/right, or any shape). Delete a bend with the Delete tool, or "Straighten" the whole leg from its sidebar.
- **Select** (`V`): drag points, connectors, bends, and splices; drag empty space to pan, scroll to zoom. Select a line to annotate its **length**.
- **⇅ Invert zoom**: flips the scroll-wheel zoom direction if it feels backwards. 
- The sketch doesn't need to be to scale — it just captures the legs and branch points. Each leg can be assigned a specific length used in the build sheet.

### 2. Attach connectors
Select a point and add connectors to it in the sidebar. A single point can hold several (two multi-pin connectors, a stack of ring terminals, etc.); they splay out around the point. Simple terminals (ring, spade, blade, bullet…) are built in; multi-pin connectors come from your library.

To relocate one, select it and hit **⤴ Move to point**, then click the destination: another connector point, any connector already sitting there, a leg (which breaks out a new point at that spot, splitting the leg's length proportionally), or empty space for a brand-new point. Pin assignments, wire colors and mate links all come with it. `Esc` cancels.

### 3. Build your connector library (Connector Library tab)
Define each connector type: name, part number, pin count, and the pin arrangement with a live visual preview. Two layout styles:
- **Grid** — rows × columns with row-major, column-major, or serpentine numbering. Click positions in the preview to populate/unpopulate them, so e.g. a relay socket is a 3×3 grid with the four corners left empty.
- **Circular** — 1–4 concentric rings with an optional center pin (pin 1 or the last pin), clockwise/counter-clockwise numbering viewed from the mating face, and a configurable first-pin position (12/3/6/9 o'clock).

Every pin can also get a custom label (85, 86, 30, 87a…) that shows on the pin maps, pinout tables, and compare view; leave labels blank to use plain position numbers. Labels are display-only. The Mate comparison tool uses the physical position for comparison.

Attach a photo to have it show up on the diagram and in the pinout editor.

**⭳ Save library / ⭱ Load library** keep the library in a file of its own, so the connectors you've already drawn up can be pulled into the next project. Loading adds to the list you've already defined. Duplicate connectors whose name is already in the project is skipped, and nothing already placed on a harness is disturbed. You can point Load at a saved library or at any project file.

![connector library](https://github.com/cegan09/HarnessPlanner/blob/main/images/connector_library.png)

### 4. Assign signals (Pinouts & Signals tab)
Signals work like ECAD nets: assign the same signal to pins on different connectors and they're assumed connected by a wire. Click any pin on the visual pin map (or in the pin table) and a popup lets you pick the signal, create a new one, or clear the pin. Wire color (solid or striped, with a color picker for each part) is defined **once per signal**, so the same signal is guaranteed the same color everywhere it appears.

**⭳ Save signals / ⭱ Load signals** do the same thing for the signal list, so a house standard set of nets, colors and gauges can be reused across projects. Same rules: it merges, and signals whose name already exists are left alone.

![signals and pinout](https://github.com/cegan09/HarnessPlanner/blob/main/images/signals_and_pinout.png)

### 5. View the wires (Layout tab)
- **Bundle view**: the harness as thick trunk lines, with each connector on a single clean tether. Wire colors show as a strip of chips on the connector box, and selecting a connector lists every pin with its signal, color, and gauge in the right panel.
- **Highlighting**: click any signal in the right panel or any wire row on a selected connector and every connector carrying that signal lights up so you can see at a glance where a signal runs.
- **Wire view**: every individual wire routed along the harness to make it easier to check connections. This view still needs work, there are some oddities with how wires are rendered. 

### Splices

When signals route to multiple destinations a splice is assumed at the nearest junction. This keeps the wire view easier to follow. Signals can be removed from automatic splices if you need to run separate wires for the same signal for whatever reason.

Automatic splices draw as small hollow rings; explicit ones are solid. A dot carrying several signals shows a count.

- **Add one** (`S`, wire view): click a junction, or anywhere along a leg, and tick the signals to splice there. Several signals can share one point. Unticked signals are left alone, they keep splicing automatically wherever they branch.
- **Edit one**: select any splice dot. The panel lists every signal running through that point with a tick box; ones marked **auto** are automatic.
- **Override**: untick a signal to suppress the splice there, and it routes straight through as separate individual wires instead. (Usually the cleaner answer is to give the runs different signal names, but both work.)
- A part-way splice can be dragged along its leg, named, or positioned precisely by distance from either end. Splices drive the wire lengths on the Build Sheet.

### 6. Get the cut list (Build Sheet tab)

Every physical wire in the harness, with its signal, type, color, gauge, both endpoints (connector + pin label) and its **cut length**, legs summed along the path plus the lead length at each connector. Splices are first-class: a spliced signal produces one wire from the splice to each endpoint, and each splice gets its own block showing where it sits along its leg and how long every wire running into it needs to be.

Set lengths on legs (select a leg in Layout) and a **Lead** on each connector (the pigtail from the harness breakout to the terminal) to get real numbers; anything missing a length is flagged. The sheet also warns when a signal reaches more than two points without a splice defined.

**Export CSV** for a spreadsheet, or **Print** for a clean paper copy to take to the bench.

### 7. Compare & mate harnesses (Compare / Mates tab)
Put two connectors side by side (typically from two different harnesses) and check pin-for-pin that the signals line up. **Link as mates** to make it permanent: from then on, any pinout edit that breaks the match raises an alert in the top bar, a badge on the Compare tab, and a red **!** on the affected connector in the layout until you resolve it.

![compare](https://github.com/cegan09/HarnessPlanner/blob/main/images/compare.png)

## Where your work is saved

Projects live in a `.json` file on your disk. Save new projects with **Save As** (or the "Not saved to a file" button in the top bar). The top bar shows `💾 your-project.json` while it's connected. **Open** loads a project file, **Save** (`Ctrl+S`) forces an immediate write, and **New** starts a blank project and asks where to put it.

The tool remembers the last file you used and reopens it on launch. The browser may ask you to re-grant access to it after a restart; the top bar then shows "Reconnect …" — click it. A copy of the project is also kept in the browser's `localStorage` purely as crash recovery, so if the two ever disagree at launch you'll be asked which one to keep.

Browsers without the File System Access API (Firefox, Safari, or any page opened straight from `file://`) may be unable to autosave to disk. There the top bar says so, **Save** downloads a copy instead, and **Open** uploads one. Be sure to save often.

Back up your project files like any other file: they're plain JSON.

The connector library and the signal list can also be saved to files of their own and loaded into other projects.

## Features to be added
1. Connector Linking - the ability to mark connectors as mating pairs, used in the compare tab to ensure compatibility. 

## Shortcuts

| Key | Action |
| --- | --- |
| `V` / `A` / `C` / `J` / `S` / `X` | Select / Add point / Connect / Jog / Splice / Delete mode |
| `Delete` | Delete selected item |
| `Esc` | Cancel connect chain / clear selection |
| `F` | Zoom to fit |
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |
| Double-click a connector | Jump to its pinout |



## License

[GPL-3.0](LICENSE)
