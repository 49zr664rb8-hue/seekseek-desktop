; 桌宠作为可选组件：安装时勾选；取消勾选则在文件复制完成后删除它
; 编译卸载器那一趟用不到这些变量和页面函数，NSIS 会把「未使用」当错误，这里关掉这两个警告
!pragma warning disable 6001
!pragma warning disable 6010

!include "LogicLib.nsh"
!include "nsDialogs.nsh"

Var PetCheckbox
Var PetCheckState

; 在「选择安装位置」之后插入一个组件选择页
; 注意：宏里只能注册页面，真正的界面必须写在函数里（MUI_HEADER_TEXT 不能在宏里直接调用）
!macro customPageAfterChangeDir
  Page custom PetPageCreate PetPageLeave
!macroend

Function PetPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 16u "选择组件"
  Pop $0
  SetCtlColors $0 0x1b1c1e transparent

  ${NSD_CreateCheckbox} 0 26u 100% 14u "安装桌宠（蓝色大肥鱼，约 70 MB）"
  Pop $PetCheckbox
  ${NSD_Check} $PetCheckbox

  ${NSD_CreateLabel} 0 48u 100% 46u "桌宠会以透明浮层显示在对话页面上，可以拖动、右键互动、点击回应。$\r$\n取消勾选则不安装桌宠，聊天、朗读等功能不受影响。"
  Pop $0

  nsDialogs::Show
FunctionEnd

Function PetPageLeave
  ${NSD_GetState} $PetCheckbox $PetCheckState
FunctionEnd

; 文件复制完成后：只有明确取消勾选才删除（静默安装时变量为空，保持安装）
!macro customInstall
  ${If} $PetCheckState == ${BST_UNCHECKED}
    RMDir /r "$INSTDIR\resources\pet"
  ${EndIf}
!macroend
