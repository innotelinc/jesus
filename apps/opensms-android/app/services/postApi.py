import hashlib
import secrets
import asyncio
from threading import Thread
import sys
from os.path import dirname, abspath, join, exists
import json
#from functools import partial

from fastapi import FastAPI, Request, HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
import uvicorn

# local imports
from services.smsApi import send_sms
from services.pathMgr import get_user_data_dir
from services.logSvc import LogService

## global vars / obj
app_name = "opensms"
platform = "linux"
logger = None

# Set the path
base_path = get_user_data_dir(app_name)
config_dir = join(base_path, 'config')

## Functions

def set_config_path(config_path:str):
    global config_dir
    config_dir = config_path

def set_api_os(os_flavour:str):
    global platform
    platform = os_flavour

def set_api_logger():
    global logger
    logger = LogService(app_name, platform)

def log_activities(message:str):
    if logger:
        Thread(
            target=logger.write_log,
            kwargs={
                "message": message
            },
            daemon=True
        ).start()

def hash_api_key(raw_key: str) -> str:
    """Hash the raw key using SHA-256."""
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()

def generate_new_api_key() -> str:
    # Generate a high-entropy secret token
    new_raw_key = secrets.token_urlsafe(32)
    new_raw_key = f"osms_{new_raw_key}"
    # Hash and store in your DB
    new_hashed_key = hash_api_key(new_raw_key)
    app_api_keys = {
        new_hashed_key: {
            "name": "opensms",
            "scopes": ["sms:write"]
        }
    }
    keys_path = join(config_dir, "keys.json")
    with open(keys_path, "w") as kf:
        json.dump(app_api_keys, kf)
    print("Created/updated the API key")
    log_activities("Created/updated the API key")
    return new_raw_key

def get_api_keys() -> dict:
    keys_path = join(config_dir, "keys.json")
    api_keys = {}
    if exists(keys_path):
        with open(keys_path, "r") as kf:
            api_keys = json.load(kf)
    return api_keys

# data formatting for request
class SmsData(BaseModel):
    number: str
    text: str
    sub_text: str | None = None

class ControlData(BaseModel):
    api: str

# FastAPI app
app = FastAPI()
security = HTTPBearer()

# api server class with callback function
class PosiApiServer:

    def __init__(self, host="0.0.0.0", port=9292):
        self.host = host
        self.port = port
        self.kivyCallback = None
        self.server: uvicorn.Server | None = None
        self.thread: Thread | None = None

    # ----------------------------
    # Control callback
    # ----------------------------
    def set_control_caller(self, callback=None):
        self.controlCallback = callback

    # ----------------------------
    # Kivy callback
    # ----------------------------
    def set_kivy_caller(self, callback=None):
        self.kivyCallback = callback

    # ----------------------------
    # Internal server runner
    # ----------------------------
    def _run(self, port=None):
        config = uvicorn.Config(
            app,
            host=self.host,
            port=port if port else self.port,
            log_level="info",
            loop="asyncio"
        )
        self.server = uvicorn.Server(config)
        app.state.server = self  # attach instance
        asyncio.run(self.server.serve())

    # ----------------------------
    # Public start
    # ----------------------------
    def start(self, port=None):
        if self.thread and self.thread.is_alive():
            print("Server already running")
            return
        self.thread = Thread(
            target=self._run,
            kwargs={
                "port": port
            },
            daemon=True
        )
        self.thread.start()
        print("FastAPI started")

    # ----------------------------
    # Public stop
    # ----------------------------
    def stop(self):
        if self.server:
            print("Stopping FastAPI...")
            self.server.should_exit = True
        if self.thread:
            self.thread.join(timeout=5)
        self.server = None
        self.thread = None
        print("FastAPI stopped")

# handle post requests

async def verify_api_key(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(security)
) -> dict:
    client_ip = request.client.host if request.client else "unknown"
    raw_token = credentials.credentials
    hashed_token = hash_api_key(raw_token)

    # 1. Lookup candidate in DB by hash
    app_api_keys = get_api_keys()
    client_info = app_api_keys.get(hashed_token)

    # 2. Timing-safe comparison against stored hash
    if not client_info or not secrets.compare_digest(
        hashed_token,
        hash_api_key(raw_token)
    ):
        print(f"Authentication failed from IP: {client_ip}")
        log_activities(f"Authentication failed from IP: {client_ip}")
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired API key",
        )
    return client_info

@app.post("/sms/")
async def process_sms_req(
    item: SmsData,
    request: Request,
    client: dict = Depends(verify_api_key)
):
    server: PosiApiServer = request.app.state.server
    client_ip = request.client.host if request.client else "unknown"
    print(f"Authenticated request from: {client_ip}")
    log_activities(f"Authenticated request from: {client_ip}")
    stat = send_sms(item.number, item.text)
    if stat:
        print(f"SMS successfully sent to: {item.number}")
        log_activities(f"SMS successfully sent to: {item.number}")
    else:
        print(f"SMS failed to: {item.number}")
        log_activities(f"SMS failed to: {item.number}")

    if server.kivyCallback:
        Thread(
            target=server.kivyCallback,
            kwargs={
                "stat": stat
            },
            daemon=True
        ).start()

    return {"stat": stat}

@app.post("/control/")
async def internal_control(item: ControlData, request: Request):
    server: PosiApiServer = request.app.state.server
    return item

# test locally
if __name__ == "__main__":
    apiServ = PosiApiServer()
    #apiServ.set_kivy_caller(kivy_func)
    apiServ.start()
