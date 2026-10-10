cmake_minimum_required(VERSION 3.22.1)
project(chattering_ink C)
# The pen's live line on an e-ink panel's overlay (ebc_nib.c, design/98).
add_library(ebc_nib SHARED ebc_nib.c)
target_compile_options(ebc_nib PRIVATE -O2 -Wall -Wextra -Werror)
target_link_libraries(ebc_nib m)
