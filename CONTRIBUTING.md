# Contributing

Use Python 3.10+ and Node.js 20+ for development. Install `requirements.txt` and run `npm ci`. Run Python tests and `npm run check` before submitting changes.

Keep audio analysis, resynthesis, model workers and HTTP host behavior separate. Source recordings must remain immutable. Never bypass revision checks, relax acoustic bounds to hide failures, or replace real generation with a mock result.

Use the bundled synthetic example for public tests. Keep local voices, workspace documents, model weights, machine paths and credentials out of commits. Report optional engine and platform coverage accurately.

Contributions use GPL-3.0-or-later.
