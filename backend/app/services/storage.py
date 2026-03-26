"""Storage service for audio file management.

Supports both Azure Blob Storage (production) and MinIO (local development).
Uses environment variables to determine which backend to use.

OWASP Security:
- Files validated before upload (size, type)
- Signed URLs for secure temporary access
- No direct file path exposure
"""
import os
import uuid
import logging
from datetime import datetime, timedelta
from typing import Optional, BinaryIO
from abc import ABC, abstractmethod

from app.core.config import settings

logger = logging.getLogger(__name__)


class StorageBackend(ABC):
    """Abstract base class for storage backends."""

    @abstractmethod
    async def upload_file(
        self,
        file: BinaryIO,
        filename: str,
        content_type: str = "audio/wav"
    ) -> str:
        """Upload file and return blob URL/path."""
        pass

    @abstractmethod
    def download_file(self, blob_path: str, local_path: str) -> str:
        """Download file from storage to local path.

        Args:
            blob_path: Path in blob storage
            local_path: Local path to save file

        Returns:
            Local path where file was saved

        Raises:
            FileNotFoundError: If blob doesn't exist
        """
        pass

    @abstractmethod
    async def get_signed_url(self, blob_path: str, expires_in: int = 3600) -> str:
        """Get a signed URL for temporary file access."""
        pass

    @abstractmethod
    async def delete_file(self, blob_path: str) -> bool:
        """Delete a file from storage."""
        pass


class MinIOStorage(StorageBackend):
    """MinIO storage backend for local development.

    Uses boto3 S3-compatible API to interact with MinIO.
    """

    def __init__(self):
        import boto3
        from botocore.client import Config

        self.bucket_name = settings.azure_storage_container_name
        self.endpoint_url = settings.minio_endpoint
        self.access_key = settings.minio_access_key
        self.secret_key = settings.minio_secret_key

        self.client = boto3.client(
            "s3",
            endpoint_url=self.endpoint_url,
            aws_access_key_id=self.access_key,
            aws_secret_access_key=self.secret_key,
            config=Config(signature_version="s3v4"),
        )

        # Ensure bucket exists
        self._ensure_bucket()

    def _ensure_bucket(self):
        """Create bucket if it doesn't exist."""
        try:
            self.client.head_bucket(Bucket=self.bucket_name)
        except Exception:
            try:
                self.client.create_bucket(Bucket=self.bucket_name)
                logger.info(f"Created MinIO bucket: {self.bucket_name}")
            except Exception as e:
                logger.warning(f"Could not create bucket: {e}")

    async def upload_file(
        self,
        file: BinaryIO,
        filename: str,
        content_type: str = "audio/wav"
    ) -> str:
        """Upload file to MinIO and return the object path."""
        # Generate unique blob path
        timestamp = datetime.utcnow().strftime("%Y/%m/%d")
        unique_id = uuid.uuid4().hex[:12]
        blob_path = f"audio/{timestamp}/{unique_id}_{filename}"

        try:
            self.client.upload_fileobj(
                file,
                self.bucket_name,
                blob_path,
                ExtraArgs={"ContentType": content_type}
            )
            logger.info(f"Uploaded file to MinIO: {blob_path}")
            return blob_path

        except Exception as e:
            logger.error(f"MinIO upload failed: {e}")
            raise

    def download_file(self, blob_path: str, local_path: str) -> str:
        """Download file from MinIO to local path."""
        try:
            self.client.download_file(
                self.bucket_name,
                blob_path,
                local_path
            )
            logger.info(f"Downloaded file from MinIO: {blob_path} -> {local_path}")
            return local_path
        except Exception as e:
            logger.error(f"MinIO download failed: {e}")
            raise FileNotFoundError(f"Could not download: {blob_path}")

    async def get_signed_url(self, blob_path: str, expires_in: int = 3600) -> str:
        """Generate a pre-signed URL for file access."""
        try:
            url = self.client.generate_presigned_url(
                "get_object",
                Params={"Bucket": self.bucket_name, "Key": blob_path},
                ExpiresIn=expires_in
            )
            return url
        except Exception as e:
            logger.error(f"Failed to generate signed URL: {e}")
            raise

    async def delete_file(self, blob_path: str) -> bool:
        """Delete file from MinIO."""
        try:
            self.client.delete_object(Bucket=self.bucket_name, Key=blob_path)
            logger.info(f"Deleted file from MinIO: {blob_path}")
            return True
        except Exception as e:
            logger.error(f"Failed to delete file: {e}")
            return False


class AzureBlobStorage(StorageBackend):
    """Azure Blob Storage backend for production."""

    def __init__(self):
        from azure.storage.blob import BlobServiceClient, generate_blob_sas, BlobSasPermissions

        self.connection_string = settings.azure_storage_connection_string
        self.container_name = settings.azure_storage_container_name

        self.blob_service_client = BlobServiceClient.from_connection_string(
            self.connection_string
        )
        self.container_client = self.blob_service_client.get_container_client(
            self.container_name
        )

        # Ensure container exists
        self._ensure_container()

    def _ensure_container(self):
        """Create container if it doesn't exist."""
        try:
            self.container_client.get_container_properties()
        except Exception:
            try:
                self.container_client.create_container()
                logger.info(f"Created Azure container: {self.container_name}")
            except Exception as e:
                logger.warning(f"Could not create container: {e}")

    async def upload_file(
        self,
        file: BinaryIO,
        filename: str,
        content_type: str = "audio/wav"
    ) -> str:
        """Upload file to Azure Blob Storage and return the blob path."""
        from azure.storage.blob import ContentSettings

        # Generate unique blob path
        timestamp = datetime.utcnow().strftime("%Y/%m/%d")
        unique_id = uuid.uuid4().hex[:12]
        blob_path = f"audio/{timestamp}/{unique_id}_{filename}"

        try:
            blob_client = self.container_client.get_blob_client(blob_path)
            blob_client.upload_blob(
                file,
                content_settings=ContentSettings(content_type=content_type),
                overwrite=True
            )
            logger.info(f"Uploaded file to Azure Blob: {blob_path}")
            return blob_path

        except Exception as e:
            logger.error(f"Azure Blob upload failed: {e}")
            raise

    def download_file(self, blob_path: str, local_path: str) -> str:
        """Download file from Azure Blob Storage to local path."""
        try:
            blob_client = self.container_client.get_blob_client(blob_path)
            with open(local_path, "wb") as f:
                download_stream = blob_client.download_blob()
                f.write(download_stream.readall())
            logger.info(f"Downloaded file from Azure Blob: {blob_path} -> {local_path}")
            return local_path
        except Exception as e:
            logger.error(f"Azure Blob download failed: {e}")
            raise FileNotFoundError(f"Could not download: {blob_path}")

    async def get_signed_url(self, blob_path: str, expires_in: int = 3600) -> str:
        """Generate a SAS URL for temporary file access."""
        from azure.storage.blob import generate_blob_sas, BlobSasPermissions

        try:
            # Parse account details from connection string
            account_name = None
            account_key = None
            for part in self.connection_string.split(";"):
                if part.startswith("AccountName="):
                    account_name = part.split("=", 1)[1]
                elif part.startswith("AccountKey="):
                    account_key = part.split("=", 1)[1]

            sas_token = generate_blob_sas(
                account_name=account_name,
                container_name=self.container_name,
                blob_name=blob_path,
                account_key=account_key,
                permission=BlobSasPermissions(read=True),
                expiry=datetime.utcnow() + timedelta(seconds=expires_in)
            )

            url = f"https://{account_name}.blob.core.windows.net/{self.container_name}/{blob_path}?{sas_token}"
            return url

        except Exception as e:
            logger.error(f"Failed to generate SAS URL: {e}")
            raise

    async def delete_file(self, blob_path: str) -> bool:
        """Delete file from Azure Blob Storage."""
        try:
            blob_client = self.container_client.get_blob_client(blob_path)
            blob_client.delete_blob()
            logger.info(f"Deleted file from Azure Blob: {blob_path}")
            return True
        except Exception as e:
            logger.error(f"Failed to delete file: {e}")
            return False


def get_storage_backend() -> StorageBackend:
    """Get the appropriate storage backend based on environment.

    Uses MinIO for local development, Azure Blob Storage for production.
    """
    if settings.environment == "development" or not settings.azure_storage_connection_string:
        logger.info("Using MinIO storage backend")
        return MinIOStorage()
    else:
        logger.info("Using Azure Blob Storage backend")
        return AzureBlobStorage()


# Global storage instance (lazy-loaded)
_storage: Optional[StorageBackend] = None


def get_storage() -> StorageBackend:
    """Get or create the storage backend singleton."""
    global _storage
    if _storage is None:
        _storage = get_storage_backend()
    return _storage
