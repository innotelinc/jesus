from kivymd.uix.boxlayout import MDBoxLayout
from kivymd.uix.menu import MDDropdownMenu
from kivymd.uix.button import MDButton, MDButtonIcon, MDButtonText

from kivy.lang import Builder
from kivy.uix.widget import Widget
from kivy.properties import StringProperty, NumericProperty, ObjectProperty, ColorProperty
from kivy.metrics import dp, sp
from kivy.utils import platform

# local imports
from services.logSvc import LogService

Builder.load_string('''

<LogBox>:
    orientation: "vertical"

    MDScrollView:
        do_scroll_x: False

        MDBoxLayout:
            id: log_box
            orientation: "vertical"
            adaptive_height: True

            MDLabel:
                id: log_container
                adaptive_height: True
                valign: "top"
                text: "No logs yet!"
                font_style: "Label"
                role: "small"

''')

class LogBox(MDBoxLayout):

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.app_name = "opensms"
        self.top_menu_items = {
            "Clear Logs": {
                "icon": "broom",
                "action": "clear-logs",
            }
        }
        self.logger = LogService(self.app_name, platform)

    def log_show(self, instance=None):
        text_log = ""
        container = self.ids.log_container
        logs = self.logger.get_api_logs()
        for line in reversed(logs):
            clean_line = line.strip()
            if clean_line:
                text_log = text_log + f"{clean_line}\n"
        container.text = text_log
        # hamburger menu
        menu_items = [
            {
                "text": menu_key,
                "leading_icon": self.top_menu_items[menu_key]["icon"],
                "on_release": lambda x=menu_key: self.top_menu_callback(x),
                "font_size": sp(36)
            } for menu_key in self.top_menu_items
        ]
        self.top_menu = MDDropdownMenu(
            items=menu_items,
        )

    def top_menu_callback(self, text_item):
        self.top_menu.dismiss()

    def clear_logs(self, instance=None):
        pass
