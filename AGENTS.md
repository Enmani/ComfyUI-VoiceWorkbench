# Development rules

Run `python -m unittest discover -s tests -v` and `npm run check` after implementation changes. Use isolated temporary workspaces for validation. Do not alter a user's active take.

Keep individual source files below 500 lines. Preserve single-pass whole-recording resynthesis, bounded control validation, immutable sources, explicit candidate adoption and revision conflicts. Document optional engines and platform checks accurately.

Machine configuration, model weights, private voices and workspace data stay out of the repository. No automatic model downloads. Clean temporary UI verification assets after checking them.
