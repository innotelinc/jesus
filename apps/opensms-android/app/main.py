import os
os.environ['KIVY_GL_BACKEND'] = 'sdl2'
import sys
import json
from threading import Thread

from kivy.lang import Builder
from kivy.core.window import Window
from kivy.utils import platform
from kivy.properties import StringProperty, NumericProperty, ObjectProperty, BooleanProperty

from kivymd.app import MDApp
from kivymd.uix.navigationbar import MDNavigationBar, MDNavigationItem
from kivymd.uix.screen import MDScreen
from kivymd.uix.boxlayout import MDBoxLayout
from kivymd.uix.button import MDButton, MDButtonIcon, MDButtonText

# IMPORTANT: Set this property for keyboard behavior
Window.softinput_mode = "below_target"

# import platform specific modules
if platform == "android":
    from jnius import autoclass, cast
    from android.permissions import check_permission, request_permissions, Permission
else:
    from services.appSvc import app_service_thread

# Local classes
class BaseMDNavigationItem(MDNavigationItem):
    icon = StringProperty()
    text = StringProperty()

class MainScreenBox(MDBoxLayout):
    top_pad = NumericProperty(0)
    bottom_pad = NumericProperty(0)
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        if platform == "android":
            try:
                from android.display_cutout import get_height_of_bar
                self.top_pad = int(get_height_of_bar('status'))
                self.bottom_pad = int(get_height_of_bar('navigation'))
            except Exception as e:
                print(f"Failed android 15 padding: {e}")
                self.top_pad = 32
                self.bottom_pad = 48

## Global definitions
__version__ = "0.0.1" # App version

# Determine the base path for your application's resources
if getattr(sys, 'frozen', False):
    # Running as a PyInstaller bundle
    base_path = sys._MEIPASS
else:
    # Running in a normal Python environment
    base_path = os.path.dirname(os.path.abspath(__file__))
kv_file_path = os.path.join(base_path, 'main_layout.kv')

## Main App Class
class OpenSmsApp(MDApp):

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.txt_dialog = None
        self.wake_lock = None
        self.api_started = False
        self.req_template = {
            "server": "stop",
        }

    def build(self):
        self.theme_cls.primary_palette = "Blue"
        self.theme_cls.accent_palette = "Orange"
        return Builder.load_file(kv_file_path)

    def on_start(self):
        # paths setup
        file_m_height = 1
        # for android
        if platform == "android":
            file_m_height = 0.9
            from android.storage import app_storage_path
            sdk_version = 28
            try:
                VERSION = autoclass('android.os.Build$VERSION')
                sdk_version = VERSION.SDK_INT
                print(f"Android SDK: {sdk_version}")
                #self.show_toast_msg(f"Android SDK: {sdk_version}")
            except Exception as e:
                print(f"Could not check the android SDK version: {e}")
                #self.show_toast_msg(f"Error checking SDK: {e}", is_error=True)
            self.android_permissions = [Permission.WAKE_LOCK, Permission.SEND_SMS, Permission.POST_NOTIFICATIONS]
            request_permissions(self.total_permissions)
            self.internal_storage = app_storage_path()
            self.config_dir = os.path.join(self.internal_storage, 'config')
            # start the listner service on Android
            try:
                self.start_service()
            except Exception as e:
                print(f"Error while starting android service: {e}")
        # non android platforms
        else:
            self.internal_storage = self.user_data_dir
            self.config_dir = os.path.join(base_path, 'services', 'config')
            Thread(target=app_service_thread, daemon=True).start()

        os.makedirs(self.config_dir, exist_ok=True)
        self.request_path = os.path.join(self.config_dir, "request.json")
        self.resp_path = os.path.join(self.config_dir, "resp.json")
        print("Init success...")

    def start_service(self):
        PythonActivity = autoclass('org.kivy.android.PythonActivity')
        mActivity = PythonActivity.mActivity
        service = autoclass('in.daslearning.autocharge.ServiceOpensmssvc')
        #argument = ''
        argument = os.environ.get('PYTHON_SERVICE_ARGUMENT', '')
        print(f"PYTHON_SERVICE_ARGUMENT: {argument}")
        #service.start(mActivity, argument)
        service.start(mActivity, 'icon', 'OpenSMS API', 'Service Running' , argument)

    def stop_service(self):
        service = autoclass('in.daslearning.autocharge.ServiceOpensmssvc')
        PythonActivity = autoclass('org.kivy.android.PythonActivity')
        mActivity = PythonActivity.mActivity
        service.stop(mActivity)

    def dir_resp_checker(self):
        import time
        while True:
            resp = None
            if os.path.exists(self.resp_path):
                with open(self.resp_path, "r") as rf:
                    resp = json.load(rf)
                if resp:
                    server_stat = resp.get("server", "")
                    if server_stat == "started":
                        if not self.api_started:
                            self.api_started = True
            time.sleep(2)

    def write_request(self):
        with open(self.request_path, "w") as cf:
            json.dump(self.req_template, cf)

    def api_server_mgr(self, instance=None):
        if not self.api_started:
            self.req_template["server"] = "start"
            self.write_request()

    def acquire_wakelock(self):
        if self.wake_lock:
            return  # already acquired
        try:
            PythonActivity = autoclass("org.kivy.android.PythonActivity")
            Context = autoclass("android.content.Context")
            activity = PythonActivity.mActivity
            PowerManager = autoclass("android.os.PowerManager")
            power_manager = cast(PowerManager, activity.getSystemService(Context.POWER_SERVICE))
            # Create wakelock (use PowerManager.FULL_WAKE_LOCK for full wakelock)
            self.wake_lock = power_manager.newWakeLock(
                PowerManager.FULL_WAKE_LOCK, "OpenSmsApp::WakeLockTag"
            )
            self.wake_lock.acquire()
            print("WakeLock acquired")
        except Exception as e:
            print(f"Wake lock aquire error: {e}")

    def release_wakelock(self):
        if self.wake_lock and self.wake_lock.isHeld():
            self.wake_lock.release()
            self.wake_lock = None
            print("WakeLock released")

    ## run on app exit
    def on_stop(self):
        print("Exiting the app...")
        if platform == "android":
            self.stop_service()
            self.release_wakelock()

    # on bottom navigation
    def on_switch_tabs(
            self,
            bar: MDNavigationBar,
            item: MDNavigationItem,
            item_icon: str,
            item_text: str,
        ):
            self.root.ids.screen_manager.current = item_text


if __name__ == '__main__':
    OpenSmsApp().run()
