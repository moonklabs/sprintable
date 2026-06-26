"""E-STORAGE-SSOT S1: blob storage provider 추상(BE 양면·catch#1)."""
from __future__ import annotations

from .base import StorageProvider
from .factory import get_storage_provider

__all__ = ["StorageProvider", "get_storage_provider"]
