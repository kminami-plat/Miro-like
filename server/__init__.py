"""Whiteboard server package.

Loading the .env file here guarantees it happens before server.db reads DATABASE_URL
at import time, for every entry point (uvicorn, scripts, tests).
"""
from . import envfile as _envfile

ENV_FILE_KEYS = _envfile.load()
