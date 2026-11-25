!define YEYU_PROG_ID "io.yeyu.markdown"
!define YEYU_CAPABILITIES "Software\Yeyu\Capabilities"

!macro YEYU_REGISTER_EXTENSION EXT
  WriteRegStr HKCU "Software\Classes\.${EXT}\OpenWithProgids" "${YEYU_PROG_ID}" ""
  WriteRegStr HKCU "${YEYU_CAPABILITIES}\FileAssociations" ".${EXT}" "${YEYU_PROG_ID}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 仅登记打开方式和系统设置中的候选项，当前用户的默认选择交由 Windows。
  WriteRegStr HKCU "Software\Classes\${YEYU_PROG_ID}" "" "Markdown Document"
  WriteRegStr HKCU "Software\Classes\${YEYU_PROG_ID}\DefaultIcon" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0'
  WriteRegStr HKCU "Software\Classes\${YEYU_PROG_ID}\shell\open\command" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "页屿"
  WriteRegStr HKCU "${YEYU_CAPABILITIES}" "ApplicationName" "页屿"
  WriteRegStr HKCU "${YEYU_CAPABILITIES}" "ApplicationDescription" "页屿 Markdown 编辑器"
  WriteRegStr HKCU "Software\RegisteredApplications" "Yeyu" "${YEYU_CAPABILITIES}"
  !insertmacro YEYU_REGISTER_EXTENSION "md"
  !insertmacro YEYU_REGISTER_EXTENSION "markdown"
  System::Call "shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\Classes\.md\OpenWithProgids" "${YEYU_PROG_ID}"
  DeleteRegValue HKCU "Software\Classes\.markdown\OpenWithProgids" "${YEYU_PROG_ID}"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Yeyu"
  DeleteRegKey HKCU "${YEYU_CAPABILITIES}"
  DeleteRegKey HKCU "Software\Classes\${YEYU_PROG_ID}"
  System::Call "shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)"
!macroend
