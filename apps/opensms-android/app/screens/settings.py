from kivymd.uix.boxlayout import MDBoxLayout
from kivymd.uix.scrollview import MDScrollView
from kivymd.uix.gridlayout import MDGridLayout
from kivymd.uix.button import MDButton, MDButtonIcon, MDButtonText
from kivymd.uix.textfield import MDTextField, MDTextFieldTrailingIcon

from kivy.lang import Builder
from kivy.uix.widget import Widget
from kivy.properties import StringProperty, NumericProperty, ObjectProperty, ColorProperty
from kivy.metrics import dp, sp

Builder.load_string('''

<ApiKeyTxtbox>:
    mode: "outlined"
    readonly: True
    #MDTextFieldTrailingIcon:
    #    icon: "content-copy"
    #    on_release: app.copy_api_key()

<SettingsBox>:
    orientation: "vertical"
    padding: dp(4)

    MDBoxLayout:
        orientation: "horizontal"
        adaptive_height: True
        adaptive_width: True
        spacing: dp(2)
        pos_hint: {"center_x": .5}

        MDButton:
            theme_bg_color: "Custom"
            md_bg_color: "green"
            on_release: app.save_settings(self)
            MDButtonIcon:
                icon: "floppy"
                color: "white"
            MDButtonText:
                text: "Save"
                color: "white"

        MDButton:
            theme_bg_color: "Custom"
            md_bg_color: "black"
            on_release: app.reset_settings(self)
            MDButtonIcon:
                icon: "undo"
                color: "white"
            MDButtonText:
                text: "Reset"
                color: "white"

    MDScrollView:
        do_scroll_x: False

        MDBoxLayout:
            id: main_scroll_bx
            orientation: "vertical"
            adaptive_height: True

            MDListItem:
                MDListItemLeadingIcon:
                    icon: "rocket-launch"
                MDListItemHeadlineText:
                    text: "Auto Start API Server"
                MDListItemSupportingText:
                    text: "Starts when app is launched"
                #MDListItemTertiaryText:
                #    text: "Tertiary text"
                MDSwitch:
                    id: auto_start_sw
                    pos_hint: {"center_y": 0.5}
                    icon_active: "check"
                    icon_inactive: "close"
                    icon_active_color: "green"
                    track_color_active: "green"
                    #active: True
                    on_release: app.save_settings(self, "switch")

            MDListItem:
                MDListItemLeadingIcon:
                    icon: "api"
                MDListItemHeadlineText:
                    text: "Port Number"
                MDListItemSupportingText:
                    text: "Needs a Stop-Start"
                MDListItemTertiaryText:
                    text: "Should be > 1024"
                MDTextField:
                    id: port_no_inp
                    mode: "filled"
                    input_filter: 'int'

            MDListItem:
                MDListItemLeadingIcon:
                    icon: "key"
                MDListItemHeadlineText:
                    text: "API Key"
                MDListItemSupportingText:
                    text: "Generate New API Key"
                MDListItemTertiaryText:
                    text: "Old key will not work"
                MDFabButton:
                    icon: "autorenew"
                    style: "small"
                    theme_bg_color: "Custom"
                    md_bg_color: "orange"
                    pos_hint: {'center_y': 0.5}
                    on_release: app.new_api_key_pop()

''')

class SettingsBox(MDBoxLayout):
    pass

class ApiKeyTxtbox(MDTextField):
    pass
