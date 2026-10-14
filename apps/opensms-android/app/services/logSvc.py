from datetime import datetime
import os

class LogService:

    def __init__(self, app_name:str, platform:str = "none"):
        if platform == "android":
            from android.storage import app_storage_path
            self.base_path = app_storage_path()
        else:
            from services.pathMgr import get_user_data_dir
            self.base_path = get_user_data_dir(app_name)
        self.config_dir = os.path.join(self.base_path, "config")
        log_dir = os.path.join(self.base_path, "logs")
        os.makedirs(log_dir, exist_ok=True)
        self.log_path = os.path.join(log_dir, "api_logs.json")

    def write_log(self, message:str):
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        entry = f"[{timestamp}] {message}\n"
        with open(self.log_path, "a", encoding="utf-8") as f:
            f.write(entry)

    def get_api_logs(self) -> list[str]:
        logs = []
        if os.path.exists(self.log_path):
            with open(self.log_path, "r", encoding="utf-8") as f:
                logs = f.readlines()
        return logs

    def clear_logs(self):
        with open(self.log_path, "w", encoding="utf-8") as f:
            f.write("")
