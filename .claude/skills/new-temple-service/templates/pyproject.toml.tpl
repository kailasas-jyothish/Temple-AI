[project]
name = "temple-{{id}}"
version = "0.1.0"
description = "{{description}}"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.115,<1",
    "uvicorn>=0.32,<1",
]

[dependency-groups]
dev = [
    "pytest>=8",
    "httpx>=0.27",
]

[tool.uv]
# An application, not a library: nothing to build or install, uv only manages
# the environment and the lockfile.
package = false

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]
