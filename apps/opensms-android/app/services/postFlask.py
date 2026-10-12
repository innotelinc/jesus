from threading import Thread

from flask import Flask, request, jsonify
from werkzeug.serving import make_server

# local imports
from services.smsApi import send_sms

app = Flask(__name__)

# API server class with callback functions
class PosiApiServer:

    def __init__(self, host="0.0.0.0", port=9292):
        self.host = host
        self.port = port
        self.kivyCallback = None
        self.controlCallback = None
        self.server = None
        self.thread = None

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
        actual_port = port if port else self.port

        # Attach this instance to the Flask application
        app.extensions["posi_api_server"] = self

        # Create a Werkzeug WSGI server
        self.server = make_server(
            self.host,
            actual_port,
            app,
            threaded=True,
        )

        print(
            f"Flask API listening on "
            f"{self.host}:{actual_port}"
        )

        try:
            self.server.serve_forever()
        finally:
            self.server.server_close()

    # ----------------------------
    # Public start
    # ----------------------------
    def start(self, port=None):
        if self.thread and self.thread.is_alive():
            print("Server already running")
            return

        self.thread = Thread(
            target=self._run,
            kwargs={"port": port},
            daemon=True,
        )
        self.thread.start()
        print("Flask API starting")

    # ----------------------------
    # Public stop
    # ----------------------------
    def stop(self):
        if self.server:
            print("Stopping Flask API...")
            self.server.shutdown()

        if self.thread:
            self.thread.join(timeout=5)

        self.server = None
        self.thread = None
        print("Flask API stopped")


# ----------------------------
# Handle POST requests
# ----------------------------
@app.post("/sms/")
def process_sms_req():
    server: PosiApiServer = app.extensions[
        "posi_api_server"
    ]

    item = request.get_json(silent=True)

    if not isinstance(item, dict):
        return jsonify({
            "error": "Expected a JSON object"
        }), 400

    number = item.get("number")
    text = item.get("text")

    if not number or not isinstance(text, str):
        return jsonify({
            "error": "Both number and text are required"
        }), 400

    stat = send_sms(number, text)

    if stat:
        print(f"SMS successfully sent to: {number}")

    if server.kivyCallback:
        Thread(
            target=server.kivyCallback,
            kwargs={"stat": stat},
            daemon=True,
        ).start()

    return jsonify({"stat": stat})
