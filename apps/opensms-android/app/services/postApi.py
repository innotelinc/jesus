import hashlib
import secrets
from fastapi import FastAPI, Request, HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
import uvicorn
from threading import Thread
import asyncio
#from functools import partial

# local imports
from services.smsApi import send_sms

# data formatting for request
class SmsData(BaseModel):
    number: str
    text: str
    sub_text: str | None = None

class ControlData(BaseModel):
    api: str

# debug

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

STORED_API_KEYS = {
    # SHA-256 hash of "my-secret-api-key"
    "325ededd6c3b9988f623c7f964abb9b016b76b0f8b3474df0f7d7c23b941381f": {
        "client_name": "DasLearning",
        "scopes": ["sms:write"],
    }
}

def hash_api_key(raw_key: str) -> str:
    """Hash the raw key using SHA-256."""
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()

async def verify_api_key(
    credentials: HTTPAuthorizationCredentials = Depends(security)
) -> dict:
    raw_token = credentials.credentials
    hashed_token = hash_api_key(raw_token)

    # 1. Lookup candidate in DB by hash
    client_info = STORED_API_KEYS.get(hashed_token)

    # 2. Timing-safe comparison against stored hash
    if not client_info or not secrets.compare_digest(
        hashed_token,
        hash_api_key(raw_token)
    ):
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired API key",
        )
    return client_info

# handle post requests
@app.post("/sms/")
async def process_sms_req(
    item: SmsData,
    request: Request,
    client: dict = Depends(verify_api_key)
):
    server: PosiApiServer = request.app.state.server

    stat = send_sms(item.number, item.text)
    if stat:
        print(f"SMS successfully sent to: {item.number}")

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

def generate_new_api_key():
    # Generate a high-entropy secret token
    new_raw_key = secrets.token_urlsafe(32)

    # Hash and store in your DB
    new_hashed_key = hashlib.sha256(new_raw_key.encode("utf-8")).hexdigest()

    print(f"Give this to the client (once): {new_raw_key}")
    print(f"Save this in your database:     {new_hashed_key}")

# test locally
if __name__ == "__main__":
    apiServ = PosiApiServer()
    #apiServ.set_kivy_caller(kivy_func)
    apiServ.start()
