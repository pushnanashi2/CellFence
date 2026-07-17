# Invalid: Python Pyproject Private Import

The consumer imports a private producer module through an absolute Python package import. The package root is declared in `pyproject.toml`, so CellFence must resolve `producer.internal` under `lib/python/` instead of treating it as external.
