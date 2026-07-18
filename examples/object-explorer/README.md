# Object Explorer Example

This example seeds a small `object-explorer-demo` project with rich logged
objects for the dashboard Objects tab.

## Run

Start the Rust API, then run:

```bash
python3 examples/object-explorer/train.py --server http://127.0.0.1:8000
```

Use `--skip-media` when you want table/text/histogram/classification objects
only.

## Expected UI

Open `/dashboard/objects`, select project `object-explorer-demo`, and filter by
Images, Text, Tables, Histograms, or Evals. Each seeded run logs the same
object keys at several steps so key and step filters are easy to verify.

## Testing

The script uses public SDK APIs only. It is deterministic and short enough for
manual local smoke runs; broader regression coverage should use the root
`python3 -m pytest` suite and the dashboard UI smoke.
