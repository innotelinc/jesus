from fastapi import FastAPI, Request
from pydantic import BaseModel
import uvicorn
from kivy.clock import Clock
from threading import Thread
import asyncio
from functools import partial

# local imports
from services.smsApi import send_sms

# data formatting for request
class SmsData(BaseModel):
    number: str
    text: str
    sub_text: str | None = None

class ControlData(BaseModel):
    api: str

# FastAPI app
app = FastAPI()

# api server class with callback function
class PosiApiServer:

    def __init__(self, host="0.0.0.0", port=8089):
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
    def _run(self):
        config = uvicorn.Config(
            app,
            host=self.host,
            port=self.port,
            log_level="info",
            loop="asyncio"
        )
        self.server = uvicorn.Server(config)
        app.state.server = self  # attach instance
        asyncio.run(self.server.serve())

    # ----------------------------
    # Public start
    # ----------------------------
    def start(self):
        if self.thread and self.thread.is_alive():
            print("Server already running")
            return
        self.thread = Thread(target=self._run, daemon=True)
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
@app.post("/sms/")
async def process_nav_notification(item: SmsData, request: Request):
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

    if server.controlCallback:
        Clock.schedule_once(partial(server.controlCallback, item))

    return item

# test locally
if __name__ == "__main__":
    apiServ = PosiApiServer()
    #apiServ.set_kivy_caller(kivy_func)
    apiServ.start()
