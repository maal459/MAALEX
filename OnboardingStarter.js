import { View, Text, Image, TouchableOpacity } from 'react-native'
import React from 'react'
import Onboarding from 'react-native-onboarding-swiper'
import { APP_LOGO, APP_NAME } from './constants/appConfig'

const Dots = ({ selected = false }) => {
    const backgroundColor = selected ? '#347dce' : '#808080';
    return (
        <View
            style={{
                height: 5,
                width: 5,
                marginHorizontal: 3,
                backgroundColor,
            }}
        />
    );
};
const Done = ({ style = {},...props }) => (
    <TouchableOpacity
        style={{
            marginRight: 12,
           ...style,
        }}
        {...props}
    >
        <Text style={{ color: '#347dce' }}>Done</Text>
    </TouchableOpacity>
);

const OnboardingStarter = ({ navigation }) => {
    return (
        <Onboarding
            onSkip={() => navigation.navigate('Home')}
            onDone={() => navigation.navigate('Home')}
            DotComponent={Dots}
            bottomBarColor="#ffffff"
            DoneButtonComponent={Done}
            pages={[
                {
                    backgroundColor: '#fff',
                    image: (
                        <Image
                            source={APP_LOGO}
                            style={{ width: 140, height: 140, resizeMode: 'contain' }}
                        />
                    ),
                    title: `Ku soo dhawoow ${APP_NAME}`,
                    subtitle:
                        'Sarrif lacag oo fudud, degdeg ah, oo diyaar kuu ah.',
                },
                {
                    backgroundColor: '#fff',
                    image: (
                        <Image
                            source={require('./assets/Edahab.png')}
                            style={{ width: 180, height: 180, resizeMode: 'contain' }}
                        />
                    ),
                    title: 'Nuqul cusub oo nadiif ah',
                    subtitle:
                        `${APP_NAME} hadda waxa uu ka madax bannaan yahay aqoonsigii iyo xogtii wax-soo-saarka ee mashruucii hore.`
                        ,
                        
                },
            ]}
        />
    )
}

export default OnboardingStarter
