from kivy.utils import platform

from os.path import join, abspath, exists, dirname
from threading import Thread

import json
import time
import sys

# local imports
from services.postApi import PosiApiServer

## OS specific setups
# for android
if platform == "android":
    from android.storage import app_storage_path
    from jnius import autoclass
    base_path = app_storage_path()
#for other platforms like windows or linux
else:
    if getattr(sys, 'frozen', False):
        # Running as a PyInstaller bundle
        base_path = sys._MEIPASS
    else:
        # Running in a normal Python environment
        base_path = dirname(abspath(__file__))

config_dir = join(base_path, 'config')
if not exists(config_dir):
    import os
    os.makedirs(config_dir, exist_ok=True)
req_file = join(config_dir, "request.json")
resp_file = join(config_dir, "resp.json")

## globals flags / vars / obj
app_api_server = PosiApiServer()
resp_template = {
    "server": "none",
}
req_data = {}
api_started = False

## functions
def write_resp():
    """ Write the response json on file. """
    global resp_template
    with open(resp_file, "w") as rf:
        json.dump(resp_template, rf)

def read_req_file():
    """ Read the command file from file (Instrunctions from main app). """
    global req_data
    if exists(req_file):
        try:
            with open(req_file, "r") as rf:
                req_data = json.load(rf)
        except Exception as e:
            print(f"Error while reading config from svc: {e}")

def api_server_control(api_stat: str):
    """ Turns API server on/off """
    global api_started
    global resp_template
    if api_stat == "stop":
        app_api_server.stop()
        api_started = False
        resp_template["server"] = "stopped"
    elif api_stat == "start":
        app_api_server.start()
        api_started = True
        resp_template["server"] = "started"
    Thread(target=write_resp, daemon=True).start()

def app_service_thread():
    """
    The main service thready runs forever till the app is running & performs the operations.
    """
    #global vars
    global api_started

    write_resp() # blank the old file
    api_server_control("start") # api server starts automatically

    # keep alive the service & check for requests
    while True:
        read_req_file()

        #handle api server
        server_stat = req_data.get("server", "")
        if not api_started and server_stat == "start":
            api_server_control("start")
        elif api_started and server_stat == "stop":
            api_server_control("stop")

        # put a sleep
        time.sleep(0.2)


# run locally
if __name__ == "__main__":
    app_service_thread()
