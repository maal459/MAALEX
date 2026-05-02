import { View, Text } from 'react-native'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import {
    SimpleLineIcons,
    AntDesign,
    MaterialIcons,
    Fontisto,
} from '@expo/vector-icons'
import React from 'react'
import { COLORS } from '../constants'
import { Platform } from 'react-native'
import HomeScreen from '../HomeScreen'
import EdahabSLSHScreen from '../EdahabSLSH'
import ZAADSLSHSCREEN from '../ZAADSLSH'
import ZAADUSDSCREEN from '../ZAADUSD'
import EdahabUSDScreen from '../EdahabUSD'
import OnboardingStarter from '../OnboardingStarter'

const Tab = createBottomTabNavigator()

const screenOptions = {
    tabBarShowLabel: false,
    headerShown: false,
    tabBarHideOnKeyboard: true,
    tabBarStyle: {
        position: 'absolute',
        bottom: 0,
        right: 0,
        left: 0,
        elevation: 0,
        height: 60,
        background: COLORS.white,
    },
}
const BottomTabNavigation = () => {
    return (
        <Tab.Navigator screenOptions={screenOptions}>
            <Tab.Screen
                name="OnboardingStarter"
                component={OnboardingStarter}
                options={{
                    tabBarIcon: ({ focused }) => {
                        return (
                            <SimpleLineIcons
                                name="Home"
                                size={24}
                                color={
                                    focused
                                        ? COLORS.primary
                                        : COLORS.secondaryBlack
                                }
                            />
                        )
                    },
                }}
            />
            <Tab.Screen
                name="ZAADUSD"
                component={ZAADUSDSCREEN}
                options={{
                    tabBarIcon: ({ focused }) => {
                        return (
                            <AntDesign
                                name="search1"
                                size={24}
                                color={
                                    focused
                                        ? COLORS.primary
                                        : COLORS.secondaryBlack
                                }
                            />
                        )
                    },
                }}
            />

            <Tab.Screen
                name="ZAADSLSH"
                component={ZAADSLSHSCREEN}
                options={{
                    tabBarIcon: ({ focused }) => {
                        return (
                            <View
                                style={{
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    backgroundColor: COLORS.primary,
                                    height: Platform.OS == 'ios' ? 50 : 60,
                                    width: Platform.OS == 'ios' ? 50 : 60,
                                    top: Platform.OS == 'ios' ? -10 : -20,
                                    borderRadius:
                                        Platform.OS == 'ios' ? 25 : 30,
                                    borderWidth: 2,
                                    borderColor: COLORS.white,
                                }}
                            >
                                <Fontisto
                                    name="blood-drop"
                                    size={24}
                                    color={COLORS.white}
                                />
                            </View>
                        )
                    },
                }}
            />

            <Tab.Screen
                name="EdahabUSD"
                component={EdahabUSDScreen}
                options={{
                    tabBarIcon: ({ focused }) => {
                        return (
                            <MaterialIcons
                                name="show-chart"
                                size={24}
                                color={
                                    focused
                                        ? COLORS.primary
                                        : COLORS.secondaryBlack
                                }
                            />
                        )
                    },
                }}
            />

            <Tab.Screen
                name="EdahabSLSH"
                component={EdahabSLSHScreen}
                options={{
                    tabBarIcon: ({ focused }) => {
                        return (
                            <AntDesign
                                name="user"
                                size={24}
                                color={
                                    focused
                                        ? COLORS.primary
                                        : COLORS.secondaryBlack
                                }
                            />
                        )
                    },
                }}
            />
        </Tab.Navigator>
    )
}

export default BottomTabNavigation
