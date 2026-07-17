# Invalid: Python Private Import

The consumer cell imports `producer.internal` directly. Python module resolution must map that to `src/producer/internal.py` and report a private cross-cell import instead of treating it as an external package.
