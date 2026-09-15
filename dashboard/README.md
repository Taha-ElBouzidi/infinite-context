# The dashboard

Your memories as a live picture: every memory a node, every wikilink an edge, and a current that
runs from the machine to the memory each time your AI recalls something.

```
node tools/dashboard.mjs --open
```

That is the whole install. No build step, no npm install, no framework. It reads `memory/`
directly, so it works on a clone that has never run anything else.

**With an empty `memory/` it draws an example constellation** so you can see what it is before you
have written anything. The banner says so, and the example disappears the moment one real memory
exists.

## Options

| | |
|---|---|
| `--port 8492` | which port, or set `BRAIN_DASHBOARD_PORT` |
| `--host 127.0.0.1` | loopback by default, on purpose. A picture of your own memory is not something to put on every interface by accident |
| `--open` | open a browser as well |

## Making it yours

Everything about the look is in `dashboard/config.json`. Edit, save, reload the page. Delete the
file and the defaults come back.

```json
{
  "name": "Orbit",
  "tagline": "second brain",
  "regions": [
    { "key": "PEOPLE", "types": ["person", "contact"], "color": "#E27D60" },
    { "key": "WORK",   "types": ["project"],           "color": "#41B3A3" },
    { "key": "NOTES",  "types": ["reference"],         "color": "#C38D9E" }
  ],
  "colors": { "void": "#101820", "accent": "#F6A21E", "pulse": "#4FC3F7" },
  "links": [{ "label": "My notes", "url": "https://example.com", "note": "obsidian" }],
  "showMachines": false
}
```

**`regions`** groups your memories into bands on the sphere. `types` matches the START of a
memory's `type`, so `feedback` also catches `feedback_rule`. The last region catches anything
unmatched. Add, remove or rename them freely: the bands, the legend and the colours all follow
this list, so there is no second place to keep in step.

**`colors`** is the whole palette. `accent` is the core and the highlights, `pulse` is the current
that runs when a memory is recalled. Anything you leave out keeps its default.

| key | what it colours |
|---|---|
| `void` | the background |
| `ink`, `ink2`, `ink3` | text, from brightest to faintest |
| `accent`, `accent2` | the core, the active control, the creation animation |
| `pulse`, `pulse2` | the current that runs on a recall |
| `up`, `down` | a machine that is active, and one that is not |

**`links`** puts your own shortcuts in the side rail. Left empty, that section does not appear at
all. Nothing is probed: the dashboard does not reach out to your URLs on a timer.

**`showMachines`** draws a node per machine that has recalled recently, with the current running
from it. It needs the recall pulse log; with no log there are simply no machine nodes.

## What you are looking at

| | |
|---|---|
| **Sphere** | memories grouped by kind, links routed through each band so the middle stays readable |
| **Constellation** | positioned by what links to what, so a visible cluster is a subject your brain keeps together |
| gold | a memory being created, and its links drawing themselves in |
| blue | a recall, running from the machine that asked to the memory it used |
| red | a memory being deleted |
| bigger and brighter | more facts and more links |

Drag to turn it, scroll or pinch to zoom, click a memory to open it and see its facts. **Right
click saves the view as a PNG** with the long edge at 3840, and the Names toggle hides every label
first if you want the picture without the words.

## On a phone

Add it to your home screen and it runs full screen with its own icon. The controls become one row
of icons along the bottom.

If you add it to the home screen and the layout looks wrong afterwards, delete the shortcut and add
it again: iOS captures a web app's configuration when the shortcut is created and keeps it for that
shortcut's life, so a shortcut made before a change never sees it.
