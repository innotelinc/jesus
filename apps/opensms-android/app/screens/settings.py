from kivymd.uix.boxlayout import MDBoxLayout
from kivymd.uix.scrollview import MDScrollView
from kivymd.uix.button import MDButton, MDButtonIcon, MDButtonText

from kivy.lang import Builder
from kivy.uix.widget import Widget
from kivy.properties import StringProperty, NumericProperty, ObjectProperty, ColorProperty
from kivy.metrics import dp, sp

Builder.load_string('''

<SettingsScroll>:
    do_scroll_x: False

    MDBoxLayout:
        id: main_scroll
        orientation: "vertical"
        adaptive_height: True

        MDListItem:
            MDListItemLeadingIcon:
                icon: "android"
            MDListItemHeadlineText:
                text: "Auto Start API Server"
            MDListItemSupportingText:
                text: "API server starts as soon as app is launched"
            #MDListItemTertiaryText:
            #    text: "Tertiary text"
            MDListItemTrailingCheckbox:
                id: auto_start_chkbx

''')

class SettingsScroll(MDScrollView):
    pass

